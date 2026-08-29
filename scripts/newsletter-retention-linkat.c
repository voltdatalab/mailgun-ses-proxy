#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define SOURCE_PATH "/proc/self/fd/3"
#define PARENT_FD 4
#define EXIT_INVALID_ARGUMENT 64
#define EXIT_LINK_FAILED 65
#define EXIT_DESTINATION_EXISTS 73

int main(int argc, char **argv) {
    struct stat source;
    struct stat parent;

    if (argc != 2 || argv[1][0] == '\0' || strchr(argv[1], '/') != NULL ||
        strcmp(argv[1], ".") == 0 || strcmp(argv[1], "..") == 0) {
        return EXIT_INVALID_ARGUMENT;
    }
    if (fstat(3, &source) != 0 || !S_ISREG(source.st_mode) || source.st_nlink != 0 ||
        fstat(PARENT_FD, &parent) != 0 || !S_ISDIR(parent.st_mode)) {
        return EXIT_INVALID_ARGUMENT;
    }

    if (linkat(
            AT_FDCWD,
            SOURCE_PATH,
            PARENT_FD,
            argv[1],
            AT_SYMLINK_FOLLOW
        ) == 0) {
        return 0;
    }

    if (errno == EEXIST) {
        return EXIT_DESTINATION_EXISTS;
    }

    return EXIT_LINK_FAILED;
}
