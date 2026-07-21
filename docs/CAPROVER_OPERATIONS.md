# Operação CapRover

## Escopo e fluxo de branches

- **Somente** a branch `caprover` é a origem de deploy do CapRover.
- `main` é um espelho de `upstream/main`; não é uma branch de deploy.
- Esta candidata (`rebuild/caprover-20260721`) deve ser revisada e promovida para `caprover` por um fluxo controlado. Não fazer deploy diretamente desta branch, de `main`, nem de qualquer branch de correção.

## Método 3: build pelo Dockerfile do repositório

Esta integração usa o Método 3: o CapRover lê o `captain-definition` na raiz e constrói a aplicação a partir do Dockerfile indicado por `dockerfilePath`. O manifesto mínimo aponta para `dockerfile`; não introduz override de imagem, compose, nem configuração adicional de porta.

O processo HTTP em runtime escuta a porta de contêiner **3000** (`PORT` tem esse padrão em `server.ts`). Configure a porta HTTP interna da app como `3000` no CapRover. Embora o Dockerfile upstream declare atualmente `EXPOSE 8080`, `EXPOSE` é apenas metadado de imagem e **não** deve orientar essa configuração do CapRover. O alinhamento entre esse metadado e a porta de runtime deve ser tratado como tarefa separada no upstream/fork; não alterar o Dockerfile nesta tarefa. A verificação de saúde é `GET /healthcheck`; o endpoint responde `200` enquanto os workers registrados estiverem saudáveis e `503` caso algum worker registrado esteja inativo.

## Configuração de ambiente

Cadastre no CapRover apenas os nomes abaixo, com os valores secretos e específicos do ambiente fornecidos fora do Git. Eles foram derivados de `.env.dev` e dos acessos a `process.env` no código; nenhum valor é versionado aqui.

### Credenciais, banco e autenticação

- `API_KEY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `DATABASE_URL`
- `DASHBOARD_JWT_SECRET`

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
e não o padrão de 30 segundos do worker. Para um lote não vazio, o heartbeat só
é renovado depois de ao menos um ACK de batch confirmado; falhas de handler ou de
ACK ficam retryable conforme a política de visibility timeout/redrive/DLQ da
fila.

No `SIGTERM` ou `SIGINT`, o worker aborta imediatamente um long poll SQS ativo e
não inicia handlers para mensagens recém-recebidas. Os handlers já em execução
podem drenar dentro do período de graça de desligamento configurado pela
plataforma (`SHUTDOWN_GRACE_MS`). Mensagens sem ACK permanecem não confirmadas e
ficam disponíveis para retry e, quando aplicável, redrive pela política da fila.

### Persistência opcional de conteúdo formatado de newsletters

- `PERSIST_NEWSLETTER_FORMATTED_CONTENTS` (opcional): valores `1`, `true`, `yes` ou `on`, sem distinção entre maiúsculas e minúsculas, ativam a persistência; `false`, vazio ou qualquer outro valor a desativam (padrão: `false`).

Quando definido como `true`, o serviço persiste conteúdos formatados completos de newsletters para auditoria. Isso pode ampliar a exposição de dados pessoais/conteúdo, o volume do banco e o período de retenção que precisa ser protegido, monitorado e removido conforme a política aplicável. Mantenha `false` salvo quando essa persistência for explicitamente necessária e houver uma política de retenção e controles de privacidade aprovados.

O comando de inicialização definido no projeto executa `prisma migrate deploy` antes de iniciar o servidor. Portanto, migrações são aplicadas no startup e exigem que `DATABASE_URL` aponte para o banco correto antes do deploy. Não executar migrações manualmente por meio de contêineres ad hoc.

Antes de qualquer deploy que possa aplicar migrações, faça um backup privado do banco, protegido e recuperável, e valide previamente o procedimento de restauração no ambiente apropriado. Planeje migrações como alterações aditivas e retrocompatíveis durante a janela em que versões antiga e nova possam coexistir; mudanças destrutivas devem ser postergadas para uma etapa posterior controlada.

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

O Dockerfile upstream executa `bun install` sem modo de lockfile congelado. Assim, o mesmo SHA de fonte pode resolver versões diferentes de dependências ainda permitidas e produzir imagens diferentes. Para cada build/deploy, registre o SHA exato de fonte construído e o identificador/digest da imagem resultante. A adoção de instalação congelada deve ser acompanhada como tarefa separada no upstream/fork; não modificar o Dockerfile nesta tarefa.

## Política sem Docker bruto

Não usar `docker`, `docker compose`, `docker-compose`, contêineres locais ad hoc ou comandos equivalentes como procedimento de build, teste, migração, deploy ou rollback. O CapRover é o único executor de build/deploy de contêineres neste fluxo; localmente, use os scripts `npm` aprovados do repositório.
