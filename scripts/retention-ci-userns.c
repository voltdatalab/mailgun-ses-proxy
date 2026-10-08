// Hosted-CI-only bootstrap. No setuid/capability installation or subuid helpers.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int exact_map(const char *text) {
    unsigned long inside, outside, count;
    char extra;
    return sscanf(text, "%lu %lu %lu %c", &inside, &outside, &count, &extra) == 3
        && inside == 0 && outside == 0 && count == 2;
}
static int read_text(int dir, const char *name, char *text, size_t size) {
    int fd = openat(dir, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    ssize_t n = read(fd, text, size - 1);
    int saved = errno;
    close(fd);
    if (n < 0 || (size_t)n == size - 1) { errno = n < 0 ? saved : EOVERFLOW; return -1; }
    text[n] = '\0';
    return 0;
}
static int write_text(int dir, const char *name, const char *text) {
    int fd = openat(dir, name, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    size_t size = strlen(text);
    ssize_t n = write(fd, text, size);
    int saved = errno;
    close(fd);
    if (n != (ssize_t)size) { errno = n < 0 ? saved : EIO; return -1; }
    return 0;
}
static int initialize_maps(int dir) {
    char text[128];
    return read_text(dir, "uid_map", text, sizeof(text)) == 0 && text[0] == '\0'
        && read_text(dir, "gid_map", text, sizeof(text)) == 0 && text[0] == '\0'
        && write_text(dir, "setgroups", "deny\n") == 0
        && read_text(dir, "setgroups", text, sizeof(text)) == 0 && strcmp(text, "deny\n") == 0
        && write_text(dir, "uid_map", "0 0 2\n") == 0
        && write_text(dir, "gid_map", "0 0 2\n") == 0
        && read_text(dir, "uid_map", text, sizeof(text)) == 0 && exact_map(text)
        && read_text(dir, "gid_map", text, sizeof(text)) == 0 && exact_map(text);
}
static int map_child(pid_t child) {
    // The only target is our unreaped fork child, blocked on a private pipe.
    // Pin its proc directory; never accept a PID/path/map from argv or env.
    char path[64];
    struct stat ours, theirs;
    snprintf(path, sizeof(path), "/proc/%ld", (long)child);
    int dir = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (dir < 0) return -1;
    int ok = stat("/proc/self/ns/user", &ours) == 0
        && fstatat(dir, "ns/user", &theirs, 0) == 0
        && (ours.st_dev != theirs.st_dev || ours.st_ino != theirs.st_ino)
        && initialize_maps(dir);
    close(dir);
    if (!ok) { errno = EPERM; return -1; }
    return 0;
}
static int hosted_mode(uid_t uid, uid_t euid, const char *actions, const char *runner, int argc, const char *flag) {
    return uid == 0 && euid == 0 && actions && strcmp(actions, "true") == 0
        && runner && strcmp(runner, "github-hosted") == 0 && argc >= 3
        && flag && strcmp(flag, "--ci-multi-uid") == 0;
}
int main(int argc, char **argv) {
    const char *actions = getenv("GITHUB_ACTIONS"), *runner = getenv("RUNNER_ENVIRONMENT");
    if (!hosted_mode(getuid(), geteuid(), actions, runner, argc, argc > 1 ? argv[1] : NULL)) {
        fputs("multi-UID bootstrap requires explicit ephemeral hosted CI root mode\n", stderr);
        return 1;
    }
    int ready[2], release[2];
    if (pipe2(ready, O_CLOEXEC) || pipe2(release, O_CLOEXEC)) { perror("bootstrap pipes"); return 1; }
    pid_t parent = getpid(), child = fork();
    if (child < 0) { perror("bootstrap fork"); return 1; }
    if (child == 0) {
        close(ready[0]); close(release[1]);
        // SIGKILL timeout of our launcher also kills unshare, whose --kill-child
        // tears down the PID namespace. Check the parent-death setup race.
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent || unshare(CLONE_NEWUSER)
            || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) _exit(1);
        char token = 'R';
        if (write(ready[1], &token, 1) != 1 || read(release[0], &token, 1) != 1 || token != 'G') _exit(1);
        close(ready[1]); close(release[0]);
        // The user namespace is already mapped. Preserve all other isolation.
        char **command = calloc((size_t)argc + 9, sizeof(char *));
        if (!command) _exit(1);
        const char *fixed[] = {"unshare", "--mount", "--net", "--pid", "--fork", "--kill-child"};
        for (size_t i = 0; i < 6; i++) command[i] = (char *)fixed[i];
        for (int i = 2; i < argc; i++) command[i + 4] = argv[i];
        execv("/usr/bin/unshare", command);
        _exit(1);
    }
    close(ready[1]); close(release[0]);
    char token;
    int ok = read(ready[0], &token, 1) == 1 && token == 'R' && map_child(child) == 0;
    if (!ok) perror("private child user-namespace mapping failed");
    if (ok) { token = 'G'; ok = write(release[1], &token, 1) == 1; }
    close(ready[0]); close(release[1]);
    if (!ok) kill(child, SIGKILL);
    int status;
    while (waitpid(child, &status, 0) < 0) { if (errno != EINTR) return 1; }
    return ok && WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
