# Operação CapRover

## Escopo e fluxo de branches

- **Somente** a branch `caprover` é a origem de deploy do CapRover.
- `main` é um espelho de `upstream/main`; não é uma branch de deploy.
- Esta candidata (`rebuild/caprover-20260721`) deve ser revisada e promovida para `caprover` por um fluxo controlado. Não fazer deploy diretamente desta branch, de `main`, nem de qualquer branch de correção.

## Método 3: build pelo Dockerfile do repositório

Esta integração usa o Método 3: o CapRover lê o `captain-definition` na raiz e constrói a aplicação a partir do Dockerfile indicado por `dockerfilePath`. O manifesto mínimo aponta para `dockerfile`; não introduz override de imagem, compose, nem configuração adicional de porta.

O processo HTTP escuta a porta de contêiner **3000** (`PORT` tem esse padrão em `server.ts`). Configure a porta HTTP interna da app como `3000` no CapRover. A verificação de saúde é `GET /healthcheck`; o endpoint responde `200` enquanto os workers registrados estiverem saudáveis e `503` caso algum worker registrado esteja inativo.

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

O comando de inicialização definido no projeto executa `prisma migrate deploy` antes de iniciar o servidor. Portanto, migrações são aplicadas no startup e exigem que `DATABASE_URL` aponte para o banco correto antes do deploy. Não executar migrações manualmente por meio de contêineres ad hoc.

## Rede e Ghost

Configure o Ghost para chamar a URL **interna** do serviço CapRover. O proxy não deve receber exposição pública direta; qualquer acesso externo deve permanecer atrás da política de rede/proxy controlada da plataforma. Não publicar a porta de contêiner nem configurar acesso público apenas para integração com Ghost.

## Staging, promoção e rollback

1. Faça staging em uma app/ambiente isolado, usando variáveis de staging, porta interna `3000` e `/healthcheck`.
2. Valide envio enfileirado, workers SQS, migrações e a integração Ghost pela URL interna antes da promoção.
3. Promova somente a branch `caprover` após revisão da candidata e aprovação operacional.
4. Para rollback, reimplante no CapRover o último commit conhecido como saudável da branch `caprover`; confirme `/healthcheck`, workers e migrações compatíveis. Não force-push, não use `main` como atalho e não altere produção durante a investigação.

## Política sem Docker bruto

Não usar `docker`, `docker compose`, `docker-compose`, contêineres locais ad hoc ou comandos equivalentes como procedimento de build, teste, migração, deploy ou rollback. O CapRover é o único executor de build/deploy de contêineres neste fluxo; localmente, use os scripts `npm` aprovados do repositório.
