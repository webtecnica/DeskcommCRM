-- manifest: na transferência em que o número NÃO pode seguir o vendedor (o contato já tem conversa no número do dono novo), a conversa que está no número do dono novo — sem dono, ou com o dono anterior — passa para ele, sem tomar conversa que alguém assumiu no meio; a conversa presa fica registrada com o dono do número de origem (#3732, continuação do #3642).
--
-- 9051 — a conversa que não pôde seguir o vendedor volta para o número dele
-- (#3732, continuação do #3642/#3658).
--
-- ─── O defeito (medido) ─────────────────────────────────────────────────────
--
-- A 9039 fez o número SEGUIR o dono e parou de propósito num caso: o contato já
-- tem conversa no número do dono novo (`uniq_conversations_1to1_per_contact_session`,
-- 0027). Ali `fn_numero_da_transferencia` devolve nulo, o dono muda e o número
-- não. Medido no baseline desta branch, caso A→B→A (C1 nasce no número de A com
-- dona A; A transfere para B e o número segue; o cliente volta a escrever no
-- número de A e nasce C2; B transfere C1 de volta para A):
--
--   C1: dono A, `channel_session_id` do número de B, `provider_conversation_id`
--       nulo → o envio de A dá 409 `conversa_em_numero_de_outro_atendente`
--       ("transfira para você", o que já foi feito);
--   C2: no número de A, dona B — a conversa VIVA do contato ficou com quem
--       transferiu, no número de quem recebeu.
--
-- Ou seja: o vendedor novo não tem onde responder, e o cliente fala no número
-- dele com uma conversa de outra pessoa.
--
-- ─── A regra ────────────────────────────────────────────────────────────────
--
-- Quando o número não pôde seguir, a conversa que ocupa o número do dono novo
-- passa para ele — a MESMA pergunta que a `fn_numero_da_transferencia` responde
-- com nulo, pelas mesmas réguas (número conectado, mesmo canal, número atual com
-- responsáveis, dono novo fora deles, grupo fora). `fn_conversa_que_continua` é
-- o espelho daquela: uma decide o número, a outra decide a conversa que já está
-- lá. Duas cópias da régua divergiriam, então a decisão mora numa função só.
--
-- A adoção passa pela porta única (`fn_conversation_assign`, recursiva), com o
-- mesmo `reason` — o evento da linha do tempo e o resto vão junto. A conversa
-- adotada não troca de número: ela já está no número do dono novo, e a função
-- devolve nulo para ela (o dono novo já responde por aquele número).
--
-- Os controles, em que nada é adotado:
--   * a conversa que ocupa o número já é de uma TERCEIRA pessoa — quem a assumiu
--     no meio continua com ela (o aviso do envio é o que aponta a conversa certa,
--     #3732 item 2);
--   * corrida: entre a leitura e a adoção alguém assumiu a conversa — a chamada
--     recursiva usa o dono lido como `p_expected_assignee` (`p_enforce_expected`),
--     então a adoção não acontece;
--   * a conversa adotada já é do dono novo;
--   * o número segue (não há colisão), ou o dono novo não tem número, ou o
--     número atual não é de ninguém — aí `fn_conversa_que_continua` responde
--     nulo e a transferência é a de sempre;
--   * `release`, `claim` e `routing`: a adoção só vale para `transfer` (o motivo
--     de Transferir um/em lote e da troca de carteira, que chama com 'transfer').
--
-- ─── Baseline ───────────────────────────────────────────────────────────────
--
-- `fn_conversa_que_continua` entra no apêndice do `supabase/baseline.sql` logo
-- depois de `fn_numero_da_transferencia` (as duas são a mesma régua, uma do lado
-- da outra), e `fn_conversation_assign` é editada no lugar na última definição
-- do apêndice — o mesmo desenho das 0426/0513.

-- ---- a conversa que continua (migration 9051, #3732) ----
-- Qual conversa do MESMO contato está no número que o dono novo tomaria — o que
-- impede a conversa de seguir o vendedor. Nula = não há colisão (a conversa vai
-- para o número novo, ou não há número novo).
--
-- É o espelho de `fn_numero_da_transferencia`: as mesmas réguas de número
-- conectado, mesmo canal, número atual de pessoas e grupo; a diferença é que ali
-- a resposta é o número livre, e aqui é a conversa que já ocupa esse número.
--
-- `limit 1` no primeiro número do dono novo é de propósito: com dois números
-- próprios, a transferência usa o PRIMEIRO (ordem estável da 9039). Se o
-- primeiro está livre não há colisão nenhuma — o segundo número do dono não
-- transforma uma transferência que deu certo em adoção.
create or replace function public.fn_conversa_que_continua(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_user_id uuid
)
returns uuid
language sql
stable
set search_path = ''
as $$
  with conversa as (
    select c.id, c.organization_id, c.contact_id, c.channel_session_id, atual.provider
      from public.conversations c
      join public.channel_sessions atual
        on atual.organization_id = c.organization_id and atual.id = c.channel_session_id
     where c.id = p_conversation_id
       and c.organization_id = p_organization_id
       and c.is_group = false
       and p_user_id is not null
  ),
  responsaveis_do_atual as (
    select r.user_id
      from conversa
      join public.channel_routing_policies p
        on p.organization_id = conversa.organization_id
       and p.channel_session_id = conversa.channel_session_id
      join public.channel_routing_responsibles r
        on r.organization_id = p.organization_id and r.policy_id = p.id
  ),
  numero_do_destino as (
    select cs.id
      from conversa
      join public.channel_routing_responsibles r
        on r.organization_id = conversa.organization_id and r.user_id = p_user_id
      join public.channel_routing_policies p
        on p.organization_id = r.organization_id and p.id = r.policy_id
      join public.channel_sessions cs
        on cs.organization_id = p.organization_id and cs.id = p.channel_session_id
     where exists (select 1 from responsaveis_do_atual)
       and not exists (select 1 from responsaveis_do_atual a where a.user_id = p_user_id)
       and cs.provider = conversa.provider
       and cs.archived_at is null
       and cs.status = 'WORKING'
       and coalesce(cs.metadata ->> 'disabled', 'false') <> 'true'
     order by cs.created_at, cs.id
     limit 1
  )
  select o.id
    from conversa
    join numero_do_destino n on true
    join public.conversations o
      on o.organization_id = conversa.organization_id
     and o.contact_id = conversa.contact_id
     and o.is_group = false
     and o.id <> conversa.id
     and o.channel_session_id = n.id
   order by o.updated_at desc, o.id
   limit 1;
$$;

revoke execute on function public.fn_conversa_que_continua(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_conversa_que_continua(uuid, uuid, uuid)
  to service_role;

CREATE OR REPLACE FUNCTION public.fn_conversation_assign(p_organization_id uuid, p_conversation_id uuid, p_to_user_id uuid, p_reason text, p_expected_assignee uuid DEFAULT NULL::uuid, p_enforce_expected boolean DEFAULT false)
 RETURNS SETOF conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
  v_numero uuid;
  v_trocou_de_numero boolean := false;
  v_continua uuid;
  v_continua_dono uuid;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  -- Conversa fora da visibilidade de quem chama responde como conversa
  -- inexistente (zero linhas). A regra fica no WHERE, com o dono da própria
  -- linha (reavaliado na versão nova se houver espera), nunca um valor do
  -- corpo. Service role (sem auth.uid) segue.
  --
  -- A EXCEÇÃO DA #3479: conversa SEM dono pode ser assumida por quem assume
  -- para si. Sem ela o modo "Só os seus" se morde: a conversa que nasceu do
  -- cadastro do contato tem dono nulo, o predicado do modo responde "não vejo"
  -- para dono nulo, e o claim — a operação que daria dono a ela — era recusado,
  -- com a tela dizendo "está com outro atendente" sobre uma conversa de
  -- ninguém. O termo se limita sozinho: exige dono nulo E dono novo =
  -- chamador, então conversa de colega (o caso que a 0685 protege), a
  -- transferência para terceiro e o release continuam respondendo zero linhas
  -- exatamente como antes.
  select * into v_conv
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
     and (
       auth.uid() is null
       or public.fn_can_view_conversation(organization_id, assigned_to_user_id)
       or (assigned_to_user_id is null and p_to_user_id = auth.uid()
           and p_reason = 'claim' and p_enforce_expected)
     )
   for no key update;

  if not found then
    return;
  end if;

  v_from := v_conv.assigned_to_user_id;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  -- ─── #3642: o número segue o vendedor ──────────────────────────────────────
  -- Numa empresa com um número por vendedor (`channel_routing_policies` +
  -- `channel_routing_responsibles`), a troca de dono mudava só o dono: a
  -- conversa continuava no `channel_session_id` do vendedor ANTERIOR e o envio
  -- (que sai pela sessão da conversa) fazia o vendedor novo responder pelo
  -- WhatsApp do colega. Aqui a conversa passa para o número conectado do dono
  -- novo, na MESMA transação — e como esta é a porta única da atribuição, a
  -- regra vale para Transferir (um e em lote), Assumir, MCP, automação e a
  -- passagem de carteira sem nenhum deles precisar conhecê-la.
  --
  -- QUAL número é a `fn_numero_da_transferencia` — a mesma que o diálogo de
  -- Transferir consulta para avisar antes de confirmar, então o aviso e o efeito
  -- não divergem. Nulo = o número fica (número compartilhado, número sem dono,
  -- dono novo sem número conectado do mesmo canal, grupo, ou o contato já tem
  -- conversa no número novo). A transferência nunca falha por causa do número.
  v_numero := public.fn_numero_da_transferencia(p_organization_id, p_conversation_id, p_to_user_id);
  v_trocou_de_numero := v_numero is not null;

  -- ─── #3732: e quando o número NÃO pôde seguir ──────────────────────────────
  -- O caso que a 9039 deixou em pé: o contato já tem conversa no número do dono
  -- novo, então o número fica e o dono muda — e a conversa VIVA do contato, que
  -- está no número do dono novo, continua com quem transferiu. O vendedor novo
  -- não tem onde responder (o envio dele na conversa presa dá 409
  -- `conversa_em_numero_de_outro_atendente`, "transfira para você" — já feito).
  --
  -- A conversa que ocupa o número do dono novo passa para ele quando está SEM
  -- dono ou com o dono ANTERIOR. Conversa que já é de uma TERCEIRA pessoa não é
  -- tomada: quem a assumiu no meio continua com ela. O dono lido vai como
  -- `p_expected_assignee` da adoção — se alguém assumir no meio, não toma nada.
  if not v_trocou_de_numero and p_to_user_id is not null and p_reason = 'transfer' then
    select o.id, o.assigned_to_user_id
      into v_continua, v_continua_dono
      from public.conversations o
     where o.id = public.fn_conversa_que_continua(
             p_organization_id, p_conversation_id, p_to_user_id)
       and o.assigned_to_user_id is distinct from p_to_user_id
       and (o.assigned_to_user_id is null
            or o.assigned_to_user_id is not distinct from v_from);
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         -- Desnormalizado JUNTO com o dono, na mesma transação: nunca existe
         -- uma janela em que id e nome discordam. NULL junto com o id quando
         -- a atribuição é removida (release) — nunca sobra um nome órfão de
         -- dono nenhum. Lido de auth.users porque quem chama esta função
         -- (RPC) não necessariamente tem acesso ao Admin API — a definer
         -- resolve por dentro.
         assigned_to_user_name = case
           when p_to_user_id is null then null
           else (select raw_user_meta_data ->> 'full_name' from auth.users where id = p_to_user_id)
         end,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         bot_silenced_until = case
           when p_reason = 'routing'  then bot_silenced_until
           when p_to_user_id is null  then (case when last_handoff_at is null
                                                 then null
                                                 else bot_silenced_until end)
           else 'infinity'::timestamptz
         end,
         -- #3642: o número acompanha o dono, e a thread do provider ANTERIOR não
         -- viaja — ela pertence ao número antigo.
         channel_session_id = case when v_trocou_de_numero then v_numero
                                   else channel_session_id end,
         provider_conversation_id = case when v_trocou_de_numero then null
                                         else provider_conversation_id end,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  -- Depois do evento da conversa transferida, para a linha do tempo contar na
  -- ordem em que aconteceu.
  if v_continua is not null then
    perform public.fn_conversation_assign(
      p_organization_id, v_continua, p_to_user_id, p_reason,
      v_continua_dono, true);
  end if;

  return next v_conv;
end;
$function$;

revoke all     on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public, anon;
grant  execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) to authenticated, service_role;
