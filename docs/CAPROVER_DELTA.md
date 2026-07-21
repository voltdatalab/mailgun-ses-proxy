# Delta da candidata CapRover

## Base e composição real

A candidata `rebuild/caprover-20260721` é baseada **diretamente** em `main`/
`upstream/main`: o merge-base e o `main` atual são
`8dd97ca0df7161a8d1f716086aee489389e42577`. Ela não é uma continuação de uma
branch histórica de produção. Sobre essa base, a candidata aplica uma pilha
intencional de patches para operar no CapRover; portanto, não é correto
classificá-la como uma alteração apenas de `captain-definition` ou de
documentação.

| Área deliberadamente portada | Evidência principal na candidata |
| --- | --- |
| Deploy reproduzível CapRover | `captain-definition`, `dockerfile`, Bun 1.3.6 fixado e `bun install --frozen-lockfile` com `bun.lock` |
| Confiabilidade SQS | batching/ACK em lote para eventos, preservação de falhas para retry/redrive/DLQ, deadlines/circuit breaker e supervisão que reinicia o processo quando um worker termina inesperadamente |
| Privacidade e operação | sanitização de logs de newsletters, telemetria SQS cacheada, health público mínimo e health operacional autenticado |
| Analytics Ghost/Mailgun | paginação por cursor estável e migração Prisma aditiva dos índices de analytics, com preflight de assinaturas |
| Qualidade da entrega | testes focados, lint/typecheck, dependências/lockfiles e workflow CI com gates Node, Bun, MySQL e MariaDB |

O manifesto permanece mínimo — `captain-definition` aponta para o Dockerfile —,
mas é apenas uma parte desse delta. A porta de runtime é 3000, não 8080.

## Linhas históricas descartadas ou superadas

As branches e commits legados abaixo **não** são a base da candidata e não devem
ser promovidos por transplantar commits. Foram descartados ou superados pela
pilha acima, reconstruída sobre `main`:

| Origem legada | Disposição |
| --- | --- |
| `de977ee`, `259648f` e `8dc8e44` | **Drop/superada.** Correções históricas de persistência, tipo e fila não são aplicadas como série independente; os requisitos equivalentes foram reavaliados e implementados/testados sobre `main`. |
| Experimentos `fix-nucleo-ghost` (`e79001a`…`7f1005a`) e os quatro commits limpos de analytics (`4a95d8b`, `579b3d5`, `dc209ed`, `050e979`) | **Drop/superada.** A candidata usa sua própria paginação, testes e migração aditiva/preflight; não herda essa sequência. |
| `new-features` e `cvm-fix` | **Drop.** Linhas históricas divergentes, fora da base direta em `main`. |
| `upstream/fix-worker-loop` (incluindo `399cc45`, `071eeb6`, `ba923f4`, `fc482ea`, `d8ac0af`, `1d215a2`) | **Drop/superada.** A candidata contém uma implementação supervisionada e testada própria; não porta a refatoração pendente como dependência. |

## Evidência e gates antes da promoção

A evidência automatizada está definida em [`.github/workflows/ci.yaml`](../.github/workflows/ci.yaml): os jobs `quality` e `bun-parity` executam lint,
typecheck, testes não-DB e build; os jobs `mysql` (8.0) e `mariadb` (11.4)
executam `prisma migrate deploy`, os cenários da migração e a suíte DB. Consulte
a execução do workflow **ci** associada ao SHA exato a promover no GitHub Actions;
a definição do workflow não substitui uma execução verde desse SHA.

A promoção continua condicionada aos gates operacionais das Tasks 14–16: Task 14
configura e valida redrive/DLQ, retenção, IAM e alertas; Task 15 valida staging,
Ghost, workers, migração e rollback; Task 16 requer a revisão/aprovação da
candidata e a evidência CI verde. Estes são gates de promoção, **não** evidência
de que esta candidata já tenha sido implantada. Nenhum deploy é afirmado por
este documento.
