/**
 * setupFile da suíte de invariantes: recria o banco `postgres` a partir do
 * MOLDE (`$TEST_DB_TEMPLATE`, criado uma vez por scripts/test-db.sh com o
 * baseline aplicado) antes de CADA arquivo de tests/invariants.
 *
 * ## Por que existe
 *
 * Os 100 arquivos falam com o MESMO Postgres efêmero e não limpam nada. Como as
 * fixtures são UUIDs fixos escritos à mão, arquivos diferentes acabam gravando
 * identidades diferentes no mesmo id — e todo insert é `on conflict do nothing`,
 * que transforma a colisão em silêncio, não em erro. Dois casos medidos na
 * issue #207, ambos reais no HEAD:
 *
 *   - `human-cases` cria a channel_session `cccccccc-0000-…-0003` como `waha`;
 *     `agent-send-template-turn` "cria" a MESMA id como `meta_cloud`. Quem
 *     chega depois não cria nada e não reclama. Se `human-cases` vier antes, o
 *     provider fica `waha`, a tool `send_template` some do run e 4 asserções
 *     caem — dizendo "o template não saiu" quando o produto está certo.
 *   - `gov-1b-team-manager-read` e `gov-6-assignee-kind` criam orgs com ids
 *     DIFERENTES e o MESMO slug `gov-inv-b`. A segunda colide no unique de slug,
 *     é engolida pelo `on conflict`, e o `user_organizations` seguinte estoura
 *     na FK. Qualquer um dos dois pode ser o perdedor — depende da ordem.
 *
 * Com a ordem default do sequencer o resultado é estável por acidente; sob
 * `--sequence.shuffle.files` era vermelho em 3 de 4 seeds. Um gate que sorteia
 * não prova o isolamento multi-tenant que ele carrega.
 *
 * ## Por que aqui e não dentro dos arquivos
 *
 * `tests/invariants/**` é congelado (loop/hooks/freeze-invariants.sh): invariante
 * que incomoda vai para a inbox de governança, não para o Edit. Renomear as
 * fixtures dos dois pares acima resolveria ESTAS duas colisões e deixaria a
 * classe intacta — a próxima entra do mesmo jeito. Isolar o estado é o conserto
 * por classe, e cabe inteiro fora do congelamento.
 *
 * ## Custo
 *
 * `create database … template` é cópia de arquivo: ~0,3s por arquivo de teste.
 * Medido na suíte inteira: 126s → 137s (+9%).
 *
 * DROP/CREATE DATABASE não rodam dentro de bloco de transação — daí o `-f -`
 * (psql manda statement a statement, autocommit) em vez de `-c "a; b"` (que o
 * psql embrulharia numa transação só). É seguro porque a config tem
 * `fileParallelism: false`: um arquivo por vez, dono único do ponteiro.
 */
import { execFileSync } from "node:child_process";

import { expect } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
const template = process.env.TEST_DB_TEMPLATE;

if (!container || !template) {
  throw new Error(
    "TEST_DB_CONTAINER/TEST_DB_TEMPLATE ausentes — a suíte de invariantes roda por " +
      "`pnpm test:db` (scripts/test-db.sh), que sobe o Postgres efêmero e aplica o baseline no molde.",
  );
}

execFileSync(
  "docker",
  ["exec", "-i", container, "psql", "-U", "postgres", "-d", "template1", "-qtA", "-v", "ON_ERROR_STOP=1", "-f", "-"],
  {
    input: `drop database if exists postgres with (force);\ncreate database postgres template ${template};\n`,
    encoding: "utf8",
  },
);

// ── a ÚNICA exceção ao molde provisionado ──────────────────────────────────────
//
// `scripts/test-db.sh` provisiona o módulo financeiro NO MOLDE depois do
// baseline: desde a 0487 as cinco tabelas da comanda (`sales`, `sale_items`,
// `commission_rules`, `commissions`, `loyalty_ledger`) nascem da
// `fn_financeiro_provisionar()` e não estão mais no `baseline.sql` — e sem
// elas quase toda esta suíte fica vermelha por ausência de schema, não por
// defeito (a cascata de LGPD tem `update sales set` no núcleo, o seed do
// `rls-isolation` semeia comanda, o catálogo de FKs do `redact-unificado`
// deriva de `sales → contacts`). Medido: 34 arquivos e 43 testes vermelhos.
//
// `tests/invariants/financeiro-provisionadora.test.ts` é o ÚNICO arquivo cuja
// pré-condição é o banco SEM o módulo — é ele que mede o provisionar de
// verdade a partir de uma instalação nova, e a própria mensagem do molde diz
// "Alguém as pôs no baseline?". Ele derruba as cinco no SEU clone (cada
// arquivo recebe um, então isto não vaza para nenhum outro) antes do molde
// tirar a impressão digital do núcleo. `expect.getState().testPath` é lido no
// topo do setupFile, que o Vitest evalua uma vez por arquivo de teste.
const SEM_O_MODULO =
  /(?:^|[/\\])(?:financeiro-provisionadora|provisionadora-de-modulo)\.test\.ts$/;
const arquivo = String((expect as unknown as { getState: () => { testPath?: string } }).getState().testPath ?? "");
if (SEM_O_MODULO.test(arquivo)) {
  execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-qtA", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    {
      // Ordem irrelevante: o `cascade` derruba as FKs entre elas.
      //
      // O segundo arquivo é `provisionadora-de-modulo.test.ts` (a varredura de
      // forma da D4). Ela roda "num banco sem módulo instalado" e, com as cinco
      // tabelas já no molde, reprovaria a própria 0487 com "escreve/altera
      // tabela que já existe sem o módulo".
      input:
        "drop table if exists public.commissions, public.sale_items, public.loyalty_ledger,\n" +
        "                 public.commission_rules, public.sales cascade;\n",
      encoding: "utf8",
    },
  );
}

// Marcador lido por tests/invariants/harness-isola-por-arquivo.test.ts. Sem ele
// aquele invariante não teria como distinguir "recebi um banco limpo porque o
// reset rodou" de "recebi um banco limpo porque calhei de ser o primeiro
// arquivo da rodada" — e passaria verde justamente na regressão que ele existe
// para pegar (o setupFile sumir da config).
process.env.DESKCOMM_INVARIANTS_DB_RESET = "1";
