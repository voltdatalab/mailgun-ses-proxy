# Delta da candidata CapRover

## Base e princípio

Esta candidata parte exatamente de `origin/main` / `upstream/main` em `8dd97ca0df7161a8d1f716086aee489389e42577`. O único delta inicial de deploy é o `captain-definition`; não há port de código, dependências, Dockerfile, testes, workflows ou lockfiles.

A decisão é manter a primeira promoção pequena e auditável. Mudanças específicas do fork em confiabilidade ou desempenho exigem uma PR separada, com testes e evidência operacional próprios.

## Matriz de aceitação

| Item / origem | Caminhos afetados ou evidência | Disposição | Motivo e condição |
| --- | --- | --- | --- |
| Manifesto CapRover mínimo | novo `captain-definition` | **aceitar agora** | É o único delta necessário ao Método 3; aponta para o Dockerfile já existente. |
| `de977ee` — configurable newsletter persistence and event parsing fixes | `lib/core/aws-utils.ts`, `lib/core/logger.ts`, `prisma/schema.prisma`, `prisma/migrations/*`, `service/database/db.ts`, `service/newsletter-service.ts` | **drop / superseded** | Mistura comportamento, schema e documentação de uma base anterior. Não é requisito do deploy mínimo e não deve ser transplantado. |
| `259648f` — newsletter send result type narrowing | `service/newsletter-service.ts` | **drop / superseded** | Ajuste pontual de uma linha pertencente à sequência antiga; a candidata usa a implementação atual do upstream. |
| `8dc8e44` — rate-limited concurrent newsletter sending | `service/newsletter-service.ts`, `service/utils/queue.ts` | **drop / superseded** | Implementação antiga de fila; não portar sem uma PR de comportamento e testes dedicada. |
| 13 experimentos de analytics de `fix-nucleo-ghost` | `service/events-service.ts` e caminhos de analytics correlatos; commits `e79001a`, `16045f7`, `e1f3c7c`, `7e70d6f`, `63c2168`, `956c9c9`, `c1c17f5`, `33038c0`, `2f108b7`, `859ab8a`, `5fb5882`, `7448e74`, `7f1005a` | **drop / superseded** | São experimentos encadeados de limite, paginação, timing e formatação da branch de produção. Não pertencem à reconstrução mínima sobre upstream. |
| Quatro commits limpos de analytics | `4a95d8b` em `service/events-service.ts`; `579b3d5` em `lib/core/aws-utils.ts`; `dc209ed` em `prisma/schema.prisma`; `050e979` em `prisma/migrations/20260504213000_add_analytics_event_indexes/migration.sql` | **drop-now / condicional** | Não aceitar agora. Podem ser propostos depois somente se um `EXPLAIN` medido no banco representativo demonstrar benefício, com migração, plano de rollback e testes. |
| `new-features` | ref `origin/new-features` | **drop / superseded** | Linha histórica divergente; não é parte da base limpa nem do deploy mínimo. |
| `cvm-fix` | ref histórica `cvm-fix` | **drop / superseded** | Linha histórica divergente; não é parte da base limpa nem do deploy mínimo. |
| `upstream/fix-worker-loop` | commits não mesclados, incluindo `399cc45`, `071eeb6`, `ba923f4`, `fc482ea`, `d8ac0af`, `1d215a2` | **não portar** | É uma refatoração grande e ainda não mesclada ao upstream; exige avaliação e PR independente. |

## Evidência de workers e newsletter

O comportamento local de workers foi superado pelo `upstream/main` nesta base: o commit `8dd97ca0df7161a8d1f716086aee489389e42577` contém `lib/core/sqs-worker.ts` e `service/newsletter-service.ts`. O primeiro é o worker SQS genérico, com ciclo de mensagens e isolamento de falhas; o segundo processa os batches de newsletter com idempotência. O inicializador em `service/background-process.ts` usa `startWorker` desses caminhos para as filas de newsletter e de eventos. Por isso, nenhuma implementação local anterior de worker é portada nesta candidata.

## Resultado de aceitação

Aceitar agora somente o manifesto e esta documentação operacional. Qualquer melhoria futura de confiabilidade ou performance específica do fork — incluindo analytics, filas, workers ou schema — deve seguir uma PR separada, testada e mensurada antes de ser considerada para `caprover`.
