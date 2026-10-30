/**
 * #3732 — a conversa que NÃO pôde seguir o vendedor volta para o número dele.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * A 9039 (`o-numero-segue-o-vendedor.test.ts`) fez o NÚMERO da conversa seguir
 * o dono novo — e parou de propósito num caso: o contato JÁ tem conversa no
 * número do dono novo (`uniq_conversations_1to1_per_contact_session`, 0027).
 * Ali `fn_numero_da_transferencia` devolve nulo, o dono muda e o número não.
 *
 * O caso A→B→A, medido no baseline antes desta correção:
 *
 *   C1 nasce no número de A com dona A;
 *   A transfere C1 para B — o número segue: C1 fica no número de B, dona B;
 *   o cliente volta a escrever no número de A e nasce C2 nesse número, dona B;
 *   B transfere C1 de volta para A — não há número livre (C2 ocupa o de A).
 *
 *   C1: dona A, número de B → o envio de A dá 409
 *       `conversa_em_numero_de_outro_atendente` ("transfira para você" — já feito);
 *   C2: número de A, dona B → a conversa VIVA do contato ficou com quem
 *       transferiu, no número de quem recebeu.
 *
 * Ou seja: o vendedor novo não tinha onde responder, e o cliente falava no
 * número dele com a conversa de outra pessoa.
 *
 * ─── O que este arquivo prova ───────────────────────────────────────────────
 *
 * 1. No caso A→B→A a conversa que está no número de A passa para A — e o envio
 *    de A nela NÃO é recusado (é o que a adoção existe para garantir).
 * 2. A adoção fica registrada na linha do tempo (`conversation_assignment_events`,
 *    o mesmo `reason` da transferência), na ordem: primeiro a transferida,
 *    depois a que continua.
 * 3. A conversa que continua SEM dono também passa.
 * 4. Conversa que uma TERCEIRA pessoa assumiu no meio NÃO é tomada.
 * 5. Controles em que nada é adotado: o número segue (não há colisão), a
 *    transferência é para quem já responde pelo número, e a conversa que
 *    continua já é do dono novo.
 * 6. O `p_expected_assignee` que a adoção usa é uma trava de verdade: dono
 *    esperado vencido, nada muda.
 * 7. `fn_conversa_que_continua` só `service_role` executa (como a irmã).
 *
 * A conversa PRESA (C1) continua com o dono novo e no número de origem, e o
 * envio nela continua recusado: é o item 2 do #3732 (o aviso que diz "continua
 * pelo número de {nome}"), fora deste arquivo de propósito.
 *
 * Organização própria (namespace `dddddddd-`) para não encostar nas governanças
 * que rodam no mesmo banco.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { vereditoDoNumero, type QuadroDoNumero } from "@/lib/channels/numero-do-atendente";

import { lastLine, sql } from "./gov-helpers";

const ORG = "dddddddd-0000-4000-8000-000000000001";
const VENDEDOR_A = "dddddddd-1111-4000-8000-000000000001"; // número A
const VENDEDOR_B = "dddddddd-1111-4000-8000-000000000002"; // número B
const VENDEDOR_C = "dddddddd-1111-4000-8000-000000000003"; // terceira pessoa (assume no meio)
const SEM_NUMERO = "dddddddd-1111-4000-8000-000000000004";

const SESSAO_A = "dddddddd-2222-4000-8000-000000000001";
const SESSAO_B = "dddddddd-2222-4000-8000-000000000002";

const POLITICA_A = "dddddddd-3333-4000-8000-000000000001";
const POLITICA_B = "dddddddd-3333-4000-8000-000000000002";

const CONTATO = "dddddddd-4444-4000-8000-000000000001"; // o caso A→B→A
const CONTATO_DO_TERCEIRO = "dddddddd-4444-4000-8000-000000000002";
const CONTATO_SEM_COLISAO = "dddddddd-4444-4000-8000-000000000003";
const CONTATO_SEM_DONO = "dddddddd-4444-4000-8000-000000000004";
const CONTATO_JA_DO_DONO = "dddddddd-4444-4000-8000-000000000005";

/** Chama a RPC como a rota chama: `service_role`. */
function transfere(
  conversa: string,
  para: string | null,
  esperado?: string | null,
): number {
  const out = sql(`
    set role service_role;
    select count(*) from public.fn_conversation_assign(
      '${ORG}', '${conversa}', ${para ? `'${para}'` : "null"}, 'transfer',
      ${esperado === undefined ? "null" : esperado ? `'${esperado}'` : "null"},
      ${esperado === undefined ? "false" : "true"});
  `);
  return Number(lastLine(out));
}

function donoDe(conversa: string): string {
  return lastLine(
    sql(`select coalesce(assigned_to_user_id::text, 'NULL') from public.conversations where id = '${conversa}';`),
  );
}

function sessaoDe(conversa: string): string {
  return lastLine(
    sql(`select coalesce(channel_session_id::text, 'NULL') from public.conversations where id = '${conversa}';`),
  );
}

/**
 * Zera as conversas do contato (e os eventos delas) no começo de cada caso.
 *
 * `conversaNova` só limpa o PAR contato+sessão, porque o caso que importa
 * precisa de duas conversas vivas do mesmo contato. Um caso anterior pode ter
 * deixado uma conversa do MESMO contato no número do dono novo — e aí a
 * transferência do caso seguinte não troca de número pelo motivo errado.
 */
function limpaContato(contato: string): void {
  sql(`
    delete from public.conversations
     where organization_id = '${ORG}' and contact_id = '${contato}';
  `);
}

/**
 * Uma conversa nova por caso. `thread` existe porque as conversas que vêm de
 * fora chegam com `provider_conversation_id` — e ele não pode viajar de número.
 */
function conversaNova(
  id: string,
  contato: string,
  sessao: string,
  dono: string | null,
  thread: string | null = "thread-do-numero-antigo",
): string {
  sql(`
    delete from public.conversations where id = '${id}';
    -- Um contato por conversa e por sessão (0027): o caso anterior desta suíte
    -- pode ter deixado uma no mesmo par.
    delete from public.conversations
     where organization_id = '${ORG}' and contact_id = '${contato}' and channel_session_id = '${sessao}';
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, provider_conversation_id)
    values ('${id}', '${ORG}', '${contato}', '${sessao}', 'claimed',
            ${dono ? `'${dono}'` : "null"}, ${thread ? `'${thread}'` : "null"});
  `);
  return id;
}

/**
 * O quadro que o envio lê para decidir a recusa — as MESMAS quatro perguntas de
 * `quadroDoNumero` (lib/channels/numero-do-atendente.ts), lidas do banco.
 * Quem traduz quadro → 409 é `vereditoDoNumero`, importada de verdade: é ela que
 * o `_handler` chama antes de gravar a mensagem.
 */
function quadroDoEnvio(conversa: string, userId: string): QuadroDoNumero {
  const linha = lastLine(
    sql(`
      with alvo as (
        select c.id, c.organization_id, c.channel_session_id, s.provider
          from public.conversations c
          join public.channel_sessions s on s.id = c.channel_session_id
         where c.id = '${conversa}' and c.organization_id = '${ORG}'
      ),
      politica as (
        select p.id
          from alvo
          join public.channel_routing_policies p
            on p.organization_id = alvo.organization_id
           and p.channel_session_id = alvo.channel_session_id
      ),
      responsaveis as (
        select r.user_id from politica
          join public.channel_routing_responsibles r
            on r.organization_id = '${ORG}' and r.policy_id = politica.id
      ),
      meus_numeros as (
        select 1
          from public.channel_routing_responsibles r
          join public.channel_routing_policies p
            on p.organization_id = r.organization_id and p.id = r.policy_id
          join public.channel_sessions cs
            on cs.organization_id = p.organization_id and cs.id = p.channel_session_id
          join alvo on true
         where r.organization_id = '${ORG}' and r.user_id = '${userId}'
           and cs.provider = alvo.provider
           and cs.status = 'WORKING'
           and cs.archived_at is null
           and coalesce(cs.metadata ->> 'disabled', 'false') <> 'true'
      )
      select
        (select count(*) from politica) > 0
          and (select count(*) from responsaveis) > 0,
        exists (select 1 from responsaveis where user_id = '${userId}'),
        exists (select 1 from meus_numeros);
    `),
  );
  const [roteamento, responde, temNumero] = linha.split("|").map((v) => v === "t");
  return {
    roteamentoPorVendedor: roteamento,
    atendenteRespondePelaSessao: responde,
    atendenteTemNumero: temNumero,
  };
}

/** O veredito do envio humano de `userId` na conversa. */
function envioRecusado(conversa: string, userId: string): boolean {
  return !vereditoDoNumero(quadroDoEnvio(conversa, userId)).ok;
}

describe("#3732 — a conversa que não pôde seguir o vendedor volta para o número dele", () => {
  beforeAll(() => {
    sql(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ('${VENDEDOR_A}', 'continua-a@invariant.test', '{"full_name":"Vendedor A"}'),
        ('${VENDEDOR_B}', 'continua-b@invariant.test', '{"full_name":"Vendedor B"}'),
        ('${VENDEDOR_C}', 'continua-c@invariant.test', '{"full_name":"Vendedor C"}'),
        ('${SEM_NUMERO}', 'continua-sem@invariant.test', '{"full_name":"Sem Numero"}')
      on conflict (id) do nothing;

      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG}', 'continua-inv', 'Continua Invariant Org', 'Continua Inv')
      on conflict (id) do nothing;

      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${VENDEDOR_A}', '${ORG}', 'agent', now()),
        ('${VENDEDOR_B}', '${ORG}', 'agent', now()),
        ('${VENDEDOR_C}', '${ORG}', 'agent', now()),
        ('${SEM_NUMERO}', '${ORG}', 'agent', now())
      on conflict (user_id, organization_id) do update
        set role = excluded.role, revoked_at = null, accepted_at = now();

      insert into public.channel_sessions
        (id, organization_id, provider, waha_session_name, webhook_secret_encrypted, status, display_name)
      values
        ('${SESSAO_A}', '${ORG}', 'waha', 'continua-a', '\\x00'::bytea, 'WORKING', 'Numero A'),
        ('${SESSAO_B}', '${ORG}', 'waha', 'continua-b', '\\x00'::bytea, 'WORKING', 'Numero B')
      on conflict (id) do update
        set status = 'WORKING', archived_at = null, metadata = '{}'::jsonb;

      insert into public.channel_routing_policies (id, organization_id, channel_session_id) values
        ('${POLITICA_A}', '${ORG}', '${SESSAO_A}'),
        ('${POLITICA_B}', '${ORG}', '${SESSAO_B}')
      on conflict (id) do nothing;

      delete from public.channel_routing_responsibles where organization_id = '${ORG}';
      insert into public.channel_routing_responsibles (organization_id, policy_id, user_id) values
        ('${ORG}', '${POLITICA_A}', '${VENDEDOR_A}'),
        ('${ORG}', '${POLITICA_B}', '${VENDEDOR_B}')
      on conflict do nothing;

      insert into public.contacts (id, organization_id, display_name) values
        ('${CONTATO}', '${ORG}', 'Contato A B A'),
        ('${CONTATO_DO_TERCEIRO}', '${ORG}', 'Contato Do Terceiro'),
        ('${CONTATO_SEM_COLISAO}', '${ORG}', 'Contato Sem Colisao'),
        ('${CONTATO_SEM_DONO}', '${ORG}', 'Contato Sem Dono'),
        ('${CONTATO_JA_DO_DONO}', '${ORG}', 'Contato Ja Do Dono')
      on conflict (id) do nothing;
    `);
  });

  afterAll(() => {
    sql(`
      delete from public.conversations where organization_id = '${ORG}';
      delete from public.channel_routing_responsibles where organization_id = '${ORG}';
      delete from public.channel_routing_policies where organization_id = '${ORG}';
      delete from public.channel_sessions where organization_id = '${ORG}';
      delete from public.contacts where organization_id = '${ORG}';
      delete from public.user_organizations where organization_id = '${ORG}';
      delete from public.organizations where id = '${ORG}';
      delete from auth.users where id in
        ('${VENDEDOR_A}', '${VENDEDOR_B}', '${VENDEDOR_C}', '${SEM_NUMERO}');
    `);
  });

  it("o caso A→B→A: a conversa que ficou no número de A passa para A, e o envio dele nela não é recusado", () => {
    limpaContato(CONTATO);
    // C1 nasce no número de A, dona A.
    const c1 = conversaNova("dddddddd-5555-4000-8000-000000000001", CONTATO, SESSAO_A, VENDEDOR_A);

    // A transfere para B: o número segue (9039), e a thread do número antigo não viaja.
    transfere(c1, VENDEDOR_B);
    expect(donoDe(c1)).toBe(VENDEDOR_B);
    expect(sessaoDe(c1)).toBe(SESSAO_B);

    // O cliente volta a escrever no número de A: nasce C2 ali, e fica com B.
    const c2 = conversaNova("dddddddd-5555-4000-8000-000000000002", CONTATO, SESSAO_A, VENDEDOR_B);
    expect(donoDe(c2)).toBe(VENDEDOR_B);

    // B transfere C1 de volta para A. O número não pode seguir: C2 ocupa o de A.
    transfere(c1, VENDEDOR_A);

    // C2 é a conversa viva no número de A: ela passa para A.
    expect(donoDe(c2)).toBe(VENDEDOR_A);
    expect(sessaoDe(c2)).toBe(SESSAO_A);
    // C1 continua com A e no número de B — a transferência aconteceu (#3658) e o
    // número não pôde seguir. O aviso dessa recusa é o item 2 do #3732.
    expect(donoDe(c1)).toBe(VENDEDOR_A);
    expect(sessaoDe(c1)).toBe(SESSAO_B);

    // E A responde em C2 sem 409: número é dele, e ele responde por ele.
    expect(envioRecusado(c2, VENDEDOR_A)).toBe(false);
    // O controle do instrumento: em C1 (número de B) a recusa AINDA existe, e é
    // ela que o item 2 do #3732 transforma em "continua pelo número de {nome}".
    expect(envioRecusado(c1, VENDEDOR_A)).toBe(true);
  });

  it("a adoção fica na linha do tempo, depois da conversa transferida", () => {
    limpaContato(CONTATO);
    const c1 = conversaNova("dddddddd-5555-4000-8000-000000000011", CONTATO, SESSAO_A, VENDEDOR_A);
    transfere(c1, VENDEDOR_B);
    const c2 = conversaNova("dddddddd-5555-4000-8000-000000000012", CONTATO, SESSAO_A, VENDEDOR_B);

    transfere(c1, VENDEDOR_A);

    const eventos = sql(`
      select e.conversation_id::text || '|' || coalesce(e.from_user_id::text, 'NULL')
             || '|' || coalesce(e.to_user_id::text, 'NULL') || '|' || e.reason
        from public.conversation_assignment_events e
        join public.conversations c on c.id = e.conversation_id
       where c.organization_id = '${ORG}'
         and e.conversation_id in ('${c1}', '${c2}')
       order by e.created_at, e.conversation_id;
    `);
    expect(eventos.split("\n")).toEqual([
      // A transferência de ida, que é a que fez o número seguir.
      `${c1}|${VENDEDOR_A}|${VENDEDOR_B}|transfer`,
      // A volta: a conversa presa muda de dono e a que continua é adotada.
      `${c1}|${VENDEDOR_B}|${VENDEDOR_A}|transfer`,
      `${c2}|${VENDEDOR_B}|${VENDEDOR_A}|transfer`,
    ]);
  });

  it("a conversa que continua SEM dono também passa para o dono novo", () => {
    limpaContato(CONTATO_SEM_DONO);
    const c1 = conversaNova("dddddddd-5555-4000-8000-000000000021", CONTATO_SEM_DONO, SESSAO_A, VENDEDOR_A);
    transfere(c1, VENDEDOR_B);
    const c2 = conversaNova("dddddddd-5555-4000-8000-000000000022", CONTATO_SEM_DONO, SESSAO_A, null);

    transfere(c1, VENDEDOR_A);

    expect(donoDe(c2)).toBe(VENDEDOR_A);
    expect(sessaoDe(c2)).toBe(SESSAO_A);
  });

  it("NÃO toma a conversa que uma TERCEIRA pessoa assumiu no meio", () => {
    limpaContato(CONTATO_DO_TERCEIRO);
    const c1 = conversaNova("dddddddd-5555-4000-8000-000000000031", CONTATO_DO_TERCEIRO, SESSAO_A, VENDEDOR_A);
    transfere(c1, VENDEDOR_B);
    // Alguém assumiu a conversa do número de A antes de a transferência voltar.
    const c2 = conversaNova("dddddddd-5555-4000-8000-000000000032", CONTATO_DO_TERCEIRO, SESSAO_A, VENDEDOR_C);

    transfere(c1, VENDEDOR_A);

    expect(donoDe(c2)).toBe(VENDEDOR_C);
    expect(sessaoDe(c2)).toBe(SESSAO_A);
    // A conversa presa continua indo para o dono novo: a transferência não falha
    // por causa do número (#3658).
    expect(donoDe(c1)).toBe(VENDEDOR_A);
  });

  it("controle: quando o número SEGUE não há adoção nenhuma", () => {
    limpaContato(CONTATO_SEM_COLISAO);
    const c1 = conversaNova(
      "dddddddd-5555-4000-8000-000000000041", CONTATO_SEM_COLISAO, SESSAO_A, VENDEDOR_A);

    transfere(c1, VENDEDOR_B);

    expect(donoDe(c1)).toBe(VENDEDOR_B);
    expect(sessaoDe(c1)).toBe(SESSAO_B);
    expect(
      lastLine(sql(`select coalesce(provider_conversation_id, 'NULL') from public.conversations where id = '${c1}';`)),
    ).toBe("NULL");
  });

  it("controle: a conversa que continua já é do dono novo — nada muda", () => {
    limpaContato(CONTATO_JA_DO_DONO);
    const c1 = conversaNova(
      "dddddddd-5555-4000-8000-000000000051", CONTATO_JA_DO_DONO, SESSAO_A, VENDEDOR_A);
    transfere(c1, VENDEDOR_B);
    const c2 = conversaNova("dddddddd-5555-4000-8000-000000000052", CONTATO_JA_DO_DONO, SESSAO_A, VENDEDOR_A);

    transfere(c1, VENDEDOR_A);

    expect(donoDe(c2)).toBe(VENDEDOR_A);
    // Só o evento da própria C1: a adoção não reatribui quem já é do dono novo.
    expect(
      sql(`
        select count(*) from public.conversation_assignment_events
         where conversation_id = '${c2}';
      `).trim(),
    ).toBe("0");
  });

  it("controle: dono novo SEM número conectado — nada é adotado", () => {
    limpaContato(CONTATO_SEM_COLISAO);
    const c1 = conversaNova(
      "dddddddd-5555-4000-8000-000000000061", CONTATO_SEM_COLISAO, SESSAO_A, VENDEDOR_A);
    const c2 = conversaNova(
      "dddddddd-5555-4000-8000-000000000062", CONTATO_SEM_COLISAO, SESSAO_B, VENDEDOR_B);

    transfere(c1, SEM_NUMERO);

    expect(donoDe(c1)).toBe(SEM_NUMERO);
    expect(sessaoDe(c1)).toBe(SESSAO_A);
    expect(donoDe(c2)).toBe(VENDEDOR_B);
  });

  it("dono esperado vencido: a trava que a adoção usa não move a conversa", () => {
    limpaContato(CONTATO);
    const c1 = conversaNova(
      "dddddddd-5555-4000-8000-000000000071", CONTATO, SESSAO_A, VENDEDOR_A);
    transfere(c1, VENDEDOR_B);
    const c2 = conversaNova("dddddddd-5555-4000-8000-000000000072", CONTATO, SESSAO_A, VENDEDOR_C);

    // Alguém assumiu no meio: quem leu "dona B" tenta com o dono esperado B.
    const linhas = transfere(c2, VENDEDOR_A, VENDEDOR_B);

    expect(linhas).toBe(0);
    expect(donoDe(c2)).toBe(VENDEDOR_C);
  });

  it("fn_conversa_que_continua só service_role executa, e aponta a conversa do número do dono novo", () => {
    limpaContato(CONTATO_DO_TERCEIRO);
    const c1 = conversaNova(
      "dddddddd-5555-4000-8000-000000000081", CONTATO_DO_TERCEIRO, SESSAO_A, VENDEDOR_A);
    transfere(c1, VENDEDOR_B);
    const c2 = conversaNova(
      "dddddddd-5555-4000-8000-000000000082", CONTATO_DO_TERCEIRO, SESSAO_A, VENDEDOR_C);

    expect(
      lastLine(
        sql(`
          set role service_role;
          select coalesce(public.fn_conversa_que_continua('${ORG}', '${c1}', '${VENDEDOR_A}')::text, 'NULL');
        `),
      ),
    ).toBe(c2);
    // Sem colisão na volta: o dono novo não tem número, então não há para onde —
    // e é por isso que a adoção nunca compete com a troca de número.
    expect(
      lastLine(
        sql(`
          set role service_role;
          select coalesce(public.fn_conversa_que_continua('${ORG}', '${c1}', '${SEM_NUMERO}')::text, 'NULL');
        `),
      ),
    ).toBe("NULL");

    for (const papel of ["anon", "authenticated"]) {
      expect(
        lastLine(
          sql(`select has_function_privilege('${papel}',
                 'public.fn_conversa_que_continua(uuid, uuid, uuid)', 'execute');`),
        ),
      ).toBe("f");
    }
  });
});
