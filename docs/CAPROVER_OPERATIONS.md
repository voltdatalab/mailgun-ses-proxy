# Operação CapRover

## Escopo e fluxo de branches

- **Somente** a branch `caprover` é a origem de deploy do CapRover.
- `main` é um espelho de `upstream/main`; não é uma branch de deploy.
- Esta candidata (`rebuild/caprover-20260721`) deve ser revisada e promovida para `caprover` por um fluxo controlado. Não fazer deploy diretamente desta branch, de `main`, nem de qualquer branch de correção.

## Método 3: build pelo Dockerfile do repositório

Esta integração usa o Método 3: o CapRover lê o `captain-definition` na raiz e constrói a aplicação a partir do Dockerfile indicado por `dockerfilePath`. O manifesto mínimo aponta para `dockerfile`; não introduz override de imagem, compose, nem configuração adicional de porta.

O processo HTTP em runtime escuta a porta de contêiner **3000** (`PORT` tem esse padrão em `server.ts`), e o Dockerfile declara `EXPOSE 3000` para refletir esse runtime. Configure a porta HTTP interna da app como `3000` no CapRover; não use 8080. A verificação pública é `GET /healthcheck`: ela retorna exclusivamente `status`, `ready`, `degraded` e `timestamp`, com `200` quando ready e `503` quando não ready. Detalhes de workers e backlog existem somente no endpoint autenticado `GET /ops/health`.

## Configuração de ambiente

Cadastre no CapRover apenas os nomes abaixo, com os valores secretos e específicos do ambiente fornecidos fora do Git. Eles foram derivados de `.env.dev` e dos acessos a `process.env` no código; nenhum valor é versionado aqui.

### Credenciais, banco e autenticação

- `API_KEY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `DATABASE_URL`
- `DASHBOARD_JWT_SECRET`
- `DASHBOARD_INITIAL_ADMIN_EMAIL`
- `DASHBOARD_INITIAL_ADMIN_PASSWORD`

### AWS, SES e SQS

- `SES_REGION`
- `SES_TRANSACTIONAL_REGION`
- `SQS_REGION`
- `NEWSLETTER_QUEUE`
- `NEWSLETTER_NOTIFICATION_QUEUE`
- `TRANSACTIONAL_NOTIFICATION_QUEUE`
- `NEWSLETTER_CONFIGURATION_SET_NAME`
- `TRANSACTIONAL_CONFIGURATION_SET_NAME`
- `SYSTEM_FROM_ADDRESS`

### Ajustes operacionais

- `NODE_ENV`
- `PORT`
- `LOG_LEVEL`
- `DB_POOL_SIZE`
- `RATE_LIMIT`
- `MAX_CONCURRENT`
- `SHUTDOWN_GRACE_MS`

### Bootstrap seguro do dashboard

`DASHBOARD_JWT_SECRET` é obrigatório para assinar e verificar sessões e deve ter pelo menos 32 caracteres. Defina também `DASHBOARD_INITIAL_ADMIN_EMAIL` com um email válido e não vazio e `DASHBOARD_INITIAL_ADMIN_PASSWORD` com pelo menos 16 caracteres. Em banco vazio, o primeiro login cria somente essa conta configurada. A remediação legada reconhece somente a linha histórica `admin@localhost`: ela é atualizada para essas credenciais; se a conta configurada já existir, somente a linha legada é removida. Valores ausentes/fracos ou falha ao remover a linha legada bloqueiam login com resposta genérica 503 e não criam conta.

Nunca passe credenciais iniciais em Git, logs ou UI. A rotação posterior ocorre somente por rota de configurações autenticada; o endpoint de login ignora campos de troca de credenciais. No preflight de produção, confirme a presença dos três secrets e que não resta conta legada no banco.

### Workers SQS: batching e concorrência

O worker de envio de newsletter permanece deliberadamente serializado: recebe e
processa **uma** mensagem por vez (`batchSize=1`, `maxConcurrency=1`), pois uma
mensagem representa uma campanha inteira. Os consumidores de eventos
`newsletter-events` e `system-events` usam por padrão lotes de até **10** e
processam até **10** handlers simultaneamente. O limite é o máximo aceito pelo
SQS para `ReceiveMessage` e `DeleteMessageBatch`; os ACKs são enviados em lotes
de no máximo 10 e somente para handlers que concluíram com sucesso. Esta
concorrência de eventos não reutiliza `MAX_CONCURRENT`, que é um ajuste distinto
do envio de destinatários.

Uma resposta de long polling vazia continua saudável e não cria polling ocupado.
A fila de newsletter usa visibility timeout de **900 segundos**, pois uma única
mensagem pode representar uma campanha inteira. As filas `newsletter-events` e
`system-events` usam visibility timeout explícito e conservador de **120
segundos**: como o ACK do lote só ocorre após a conclusão dos handlers, o prazo
precisa acomodar o handler mais lento do lote concorrente, além do envio do ACK,
e não o padrão de 30 segundos do worker. Para um lote não vazio, o receive marca
liveness e processamento antes dos handlers, com prazo limitado pelo
`visibilityTimeout`; um ACK confirmado continua sendo o único sinal de sucesso
de entrega. Falhas de handler ou de ACK ficam retryable conforme a política de
visibility timeout/redrive/DLQ da fila.

No `SIGTERM` ou `SIGINT`, o worker aborta imediatamente um long poll SQS ativo e
não inicia handlers para mensagens recém-recebidas. Os handlers já em execução
podem drenar dentro do período de graça de desligamento configurado pela
plataforma (`SHUTDOWN_GRACE_MS`). Mensagens sem ACK permanecem não confirmadas e
ficam disponíveis para retry e, quando aplicável, redrive pela política da
fila.

### Health público mínimo e telemetria SQS autenticada

`GET /healthcheck` é o probe público mínimo do CapRover. Ele não requer Basic Auth e expõe exatamente `status`, `ready`, `degraded` e `timestamp`; não inclui workers, backlog, telemetria SQS ou outros detalhes operacionais. Configure o probe da plataforma para esse caminho.

`GET /ops/health` exige Basic Auth com a API key e é o endpoint operacional que mostra snapshots cacheados dos três workers esperados (`newsletter-sender`, `newsletter-events`, `system-events`), liveness/idade de heartbeat, contadores agregados, idade observada de mensagem e profundidades SQS `visible`, `notVisible` e `delayed`. Não o publique: mantenha-o acessível somente pela rede/proxy administrativo controlado.

Cada worker solicita `GetQueueAttributes` no startup/primeiro poll e, no máximo, a cada `SQS_TELEMETRY_SAMPLE_INTERVAL_MS` (padrão **30000**, limitado a 10000–300000 ms). A role AWS precisa de `sqs:GetQueueAttributes` além das permissões de consumo já necessárias. Falhar essa amostra não interrompe receive, handler ou ACK e registra/expõe somente `telemetryErrorClass`, jamais URL da fila, corpo, destinatário, ReceiptHandle, mensagem/stack de erro ou payload.

O endpoint responde **503** quando qualquer worker esperado está ausente, morto, tem heartbeat stale enquanto ocioso ou permanece processando além do prazo derivado do seu `visibilityTimeout`; um worker vivo em processamento antes desse prazo permanece ready, mesmo se o heartbeat anterior tiver mais de 60 segundos. Backlog alto, telemetria ausente/stale ou idade observada alta retornam **200** com `degraded: true`, para que um restart não agrave uma fila congestionada. Defaults configuráveis e validados: `HEALTH_WORKER_STALE_MS=60000` (30000–300000), `SQS_TELEMETRY_STALE_MS=90000` (30000–600000), `SQS_BACKLOG_DEGRADED_THRESHOLD=1000` (1–1000000) e `SQS_AGE_DEGRADED_MS=900000` (10000–86400000).

Crie alertas internos para `visible`, `notVisible`, `delayed`, `oldestObservedAgeMs`, telemetria stale/falha e métricas da DLQ. Esta telemetria não configura filas, DLQs, políticas IAM além da exigência acima, nem alertas/cloud exporters: política, DLQ e alarmes efetivos permanecem controles operacionais da Task 14.

### Supervisão e restart dos workers

Os três loops SQS são supervisionados conjuntamente pelo processo HTTP. Se um
worker resolver ou rejeitar **antes** de um desligamento solicitado, inclusive
quando o circuit breaker encerra o loop após erros consecutivos, o processo
inicia um desligamento fatal coordenado: para de aceitar novas conexões HTTP,
solicita que todos os workers abortem long polls e permite que handlers em voo
drenem por `SHUTDOWN_GRACE_MS`. Depois que os workers restantes se assentam, o
processo sai com código **1**, para que o CapRover reinicie o contêiner. Assim,
um worker marcado como morto não pode deixar o HTTP e os demais workers mantendo
um contêiner degradado vivo.

Em `SIGTERM`/`SIGINT`, a parada dos workers é esperada e o mesmo dreno coordenado
termina com código **0** depois que todos se assentarem. Se o período de graça
expirar, o processo força a saída com código **1**; isso evita que um handler
travado impeça a plataforma de substituir o contêiner. Os logs de supervisão
registram apenas o nome do worker, o resultado e `errorClass`, sem a razão ou
stack brutas.

### Persistência opcional de conteúdo formatado de newsletters

- `PERSIST_NEWSLETTER_FORMATTED_CONTENTS` (opcional): valores `1`, `true`, `yes` ou `on`, sem distinção entre maiúsculas e minúsculas, ativam a persistência; `false`, vazio ou qualquer outro valor a desativam (padrão: `false`).

Quando definido como `true`, o serviço persiste conteúdos formatados completos de newsletters para auditoria. Isso pode ampliar a exposição de dados pessoais/conteúdo, o volume do banco e o período de retenção que precisa ser protegido, monitorado e removido conforme a política aplicável. Mantenha `false` salvo quando essa persistência for explicitamente necessária e houver uma política de retenção e controles de privacidade aprovados.

### Privacidade dos logs de newsletter

Os logs operacionais de newsletter não devem conter endereços de destinatários, corpos/payloads de mensagens, `ReceiptHandle` do SQS nem IDs por mensagem (incluindo `messageId`). Registre somente nome do worker, identificadores agregados de baixo risco (por exemplo, `newsletterBatchId`, `siteId`, `errorId`), contagens limitadas e `errorClass`; erros não devem registrar o objeto bruto. A persistência de payloads para auditoria é um controle separado e só é habilitada pela flag `PERSIST_NEWSLETTER_FORMATTED_CONTENTS` descrita acima.

O comando de inicialização definido no projeto executa `prisma migrate deploy` antes de iniciar o servidor. Portanto, migrações são aplicadas no startup e exigem que `DATABASE_URL` aponte para o banco correto antes do deploy. Não executar migrações manualmente por meio de contêineres ad hoc.

Antes de qualquer deploy que possa aplicar migrações, faça um backup privado do banco, protegido e recuperável, e valide previamente o procedimento de restauração no ambiente apropriado. Planeje migrações como alterações aditivas e retrocompatíveis durante a janela em que versões antiga e nova possam coexistir; mudanças destrutivas devem ser postergadas para uma etapa posterior controlada.

### Preflight da migração de índices de analytics Ghost

Antes da promoção para produção, faça um backup privado e recuperável do banco e confirme a janela de DDL: inspecione sessões/locks em andamento e o impacto esperado do `CREATE INDEX` no tamanho e carga das tabelas. Não execute essa inspeção ou a migração a partir de contêineres ad hoc; o deploy controlado executa `prisma migrate deploy`.

A migração `20260721120000_add_ghost_analytics_indexes` lê `information_schema.STATISTICS` no schema atual e valida, para cada índice, a definição exata: contagem e colunas ordenadas (`SEQ_IN_INDEX`, `COLUMN_NAME`), `NON_UNIQUE`, ausência de prefixo (`SUB_PART IS NULL`), direção ascendente (`COLLATION = 'A'`) e tipo B-tree (`INDEX_TYPE = 'BTREE'`). Ela aplica essa assinatura a `NewsletterNotifications(type, created, id)` não único (`idx_notifications_type_created_id`) e `NewsletterBatch(siteId)` não único (`NewsletterBatch_siteId_idx`). Em instalações limpas, os nomes mapeados pelo Prisma são criados. Se já houver a mesma definição exata sob outro nome legado, a migração a reutiliza intencionalmente como no-op: ela não renomeia, remove nem cria um índice equivalente duplicado. Essa divergência de nome legado permanece documentada até uma mudança separada, avaliada para risco online e rollback.

Se qualquer nome esperado já existir com definição incompatível, o preflight global dos dois índices bloqueia explicitamente antes de qualquer DDL da migração, em vez de mascarar o drift ou deixar aplicação parcial. O diagnóstico usa um sentinela fixo de `information_schema`, sem interpolar metadados observados. Não acrescentar `ALGORITHM` ou `LOCK` sem validação específica do motor/versão.

A conclusão local/estática desta mudança não substitui validação contra banco real: a Task 12/14 exige que, antes da Task 14, o workflow GitHub Actions `ci` esteja verde nos jobs `mysql` (MySQL 8.0) e `mariadb` (MariaDB 11.4). Eles executam `prisma migrate deploy` em banco limpo, toda a suíte com `runPrismaTests=true` e relatório JSON que falha para testes pending/skipped ou failed. Os mesmos jobs executam os três cenários isolados da migração: criação limpa das assinaturas exatas, no-op para nomes legados equivalentes e abort global quando o segundo nome esperado é incompatível. A CI também executa `EXPLAIN` especificamente para `event=delivered OR opened` (além das consultas de tipo único), registra o plano antes de produção e aceita que o OR possa exigir filesort/merge apesar de usar o índice. Esta candidata **inclui** uma migração aditiva de índices/schema; antes de produção, confirme que ela foi registrada, que os índices ou seus equivalentes legados válidos existem, e que a aplicação/Ghost continuam funcionais antes da promoção.

## Paginação de analytics Ghost/Mailgun

`GET /v3/{siteId}/events` mantém o formato Mailgun `{items, paging: {next}}`. A primeira chamada aceita o `start` numérico legado (inteiro seguro maior ou igual a zero). Quando essa página retorna itens, o link `paging.next` remove o offset e inclui um cursor opaco URL-safe; se a página legada estiver vazia, mantém o mesmo `start`, sem cursor, para não reiniciar no offset zero. Ghost deve seguir esse link sem reconstruí-lo: ele preserva `event`, `begin`, `end`, `limit`, `ascending` e filtros compatíveis adicionais. A ordenação `(created, id)` fornece travessia estável, sem duplicações, para um conjunto de resultados fixo, inclusive quando eventos desse conjunto têm o mesmo `created`; ela não fornece isolamento de snapshot entre requisições. Um insert confirmado entre páginas no timestamp `created` exato da fronteira pode ordenar atrás de um cursor UUID aleatório e não aparecer nessa travessia. A validação/canary deve verificar a convergência do Ghost durante ingestão ativa; polling incremental e deduplicação por ID do evento são a camada de recuperação.

Os parâmetros são validados estritamente: somente sintaxe inteira base 10 é aceita (sem expoente, hexadecimal, decimal ou `Infinity`) e todo inteiro deve ser seguro em JavaScript. `limit` é de 1 a 300 (padrão 300), `start` é maior ou igual a zero, e `begin`/`end` são segundos que devem converter para uma `Date` JavaScript válida, além de satisfazerem `begin < end`; entradas inválidas retornam `400`. `ascending` aceita apenas `yes`, `true` ou `1` para ordem ascendente; ausente, `no`, `false` ou `0` usam ordem descendente. Um cursor inválido ou incompatível com a ordem retorna `400` sem expor detalhes internos. Uma página vazia mantém um `paging.next` determinístico, sem avançar cursor; Ghost pode encerrar a leitura ao receber `items` vazio.

A janela temporal continua filtrando **`created` (tempo de ingestão)**, e não o timestamp do evento SES. Esta alteração de paginação não muda a semântica temporal nem os filtros de site/tipo.

## Rede e Ghost

Configure o Ghost para chamar a URL **interna** do serviço CapRover. O proxy não deve receber exposição pública direta; qualquer acesso externo deve permanecer atrás da política de rede/proxy controlada da plataforma. Não publicar a porta de contêiner nem configurar acesso público apenas para integração com Ghost.

## Staging, promoção e rollback

## SQS: redrive, DLQ e retenção

Antes de promover para produção a versão que não descarta manualmente mensagens com falha, configure uma política de redrive com DLQ em **todas** as filas SQS relevantes. A DLQ deve ter retenção adequada para investigação e recuperação, e alertas devem cobrir mensagens recebidas/enviadas à DLQ e sua profundidade. Falhas de processamento permanecem na fila para que a política SQS faça as tentativas e o redrive; não trate a ausência dessa configuração como proteção suficiente em produção.

1. Faça staging em uma app/ambiente isolado, usando variáveis de staging, porta interna `3000` e `/healthcheck`.
2. Valide envio enfileirado, workers SQS, migrações e a integração Ghost pela URL interna antes da promoção.
3. Promova somente a branch `caprover` após revisão da candidata e aprovação operacional.
4. Para rollback, primeiro determine se o schema que recebeu `prisma migrate deploy` continua compatível com a imagem anterior. Rollback de código/imagem **não desfaz o schema**. Não reimplante código antigo contra schema incompatível. Se a reversão de schema for necessária, use somente o procedimento de restauração previamente validado e o backup privado feito antes do deploy; então confirme integridade dos dados, `/healthcheck`, workers e compatibilidade das migrações. Não force-push, não use `main` como atalho e não altere produção durante a investigação.

## Reprodutibilidade do build

O Dockerfile fixa Bun 1.3.6 e executa `bun install --frozen-lockfile` usando `bun.lock`, portanto o build não pode resolver versões novas silenciosamente. Para cada build/deploy, registre o SHA exato de fonte construído e o identificador/digest da imagem resultante.

## Política sem Docker bruto

Não usar `docker`, `docker compose`, `docker-compose`, contêineres locais ad hoc ou comandos equivalentes como procedimento de build, teste, migração, deploy ou rollback. O CapRover é o único executor de build/deploy de contêineres neste fluxo; localmente, use os scripts `npm` aprovados do repositório.
