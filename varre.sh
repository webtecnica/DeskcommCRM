#!/usr/bin/env bash
# varre.sh — varre o histórico do CI (workflow e2e.yml) e MEDe a instabilidade
# de followup-cartoes.spec.ts e logo-moldura-no-tema-escuro.spec.ts (issue #1218).
#
# Uso:  bash varre.sh > /tmp/1218.txt 2>&1
# Garde: grep -c RUN /tmp/1218.txt   deve devolver >= 50 (runs com log lido).
#
# Por que curl -sL: `gh api .../jobs/<id>/logs` devolve 0 bytes com exit 0
# (302 não seguido). Por isso o download é feito com curl -sL, seguindo o 302.
# Por que contar os ✓: um log vazio (0 bytes, ou sem nenhuma linha do reporter)
# lê como "nenhuma falha" — só afirmamos "sem vermelho" quando os ✓ foram
# contados e o total é maior que zero.
#
# O que é falha: linha do reporter `list` no formato
#   ✘  25 [chromium] › tests/e2e/<spec>.ts:LINHA:COL › ...
# O log da API prefixa cada linha com carimbo de hora, por isso o padrão não
# ancora em `^` (sonda ancorada em `^` devolve zero — e zero lê como "verde").
set -uo pipefail

REPO="melgarafael/DeskcommCRM"
LIMIT="${LIMIT:-100}"
PREFIX="e2e-parte (3)"
SPEC_A="followup-cartoes.spec.ts"
SPEC_B="logo-moldura-no-tema-escuro.spec.ts"
# casos citados na issue: followup-cartoes:281 e logo-moldura:378
CASO_A="followup-cartoes.spec.ts:281"
CASO_B="logo-moldura-no-tema-escuro.spec.ts:378"

PAT_OK='✓[[:space:]]+[0-9]+[[:space:]]+\[[^]]*\][[:space:]]+›'
# exige "› tests/e2e/" para não contar como vermelho a linha de comentário do
# próprio workflow, que cita `✘  36 [chromium] › …` dentro de um comentário
PAT_VERM='✘[[:space:]]+[0-9]+[[:space:]]+\[[^]]*\][[:space:]]+›[[:space:]]+tests/e2e/'

WORK="${TMPDIR:-/tmp}/varre1218.$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

n() { grep -acE "$1" "$2" 2>/dev/null || true; }        # linhas que casam (ERE)
nf() { grep -acF "$1" "$2" 2>/dev/null || true; }       # linhas que citam o spec (literal)

# 1) as runs do workflow (REST via gh CLI; a search API silencia sob volume)
gh run list --repo "$REPO" --workflow=e2e.yml --limit "$LIMIT" \
  --json databaseId,createdAt --jq '.[] | "\(.databaseId) \(.createdAt)"' \
  > "$WORK/ids.txt" 2> "$WORK/ids.err"
N_IDS=$(grep -c . "$WORK/ids.txt" || true)
JANELA_NOVA=$(head -1 "$WORK/ids.txt" | awk '{print $2}')
JANELA_VELHA=$(tail -1 "$WORK/ids.txt" | awk '{print $2}')
echo "# varre.sh repo=$REPO workflow=e2e.yml limit=$LIMIT job=\"$PREFIX\""
echo "# specs: $SPEC_A | $SPEC_B   (casos da issue: $CASO_A, $CASO_B)"
if [ "${N_IDS:-0}" -eq 0 ]; then
  echo "# ERRO: gh run list devolveu 0 runs: $(head -c 300 "$WORK/ids.err")"
  exit 1
fi

N_total=0; N_sem_job=0; N_log_ruim=0
FALHAS_A=0; FALHAS_B=0                      # ocorrências vermelhas (tentativas)
RUNS_A=0; RUNS_B=0; RUNS_QUALQUER=0         # runs com >=1 vermelho
RUNS_SO_A=0; RUNS_SO_B=0; RUNS_AMBOS=0
RUNS_CASO_A=0; RUNS_CASO_B=0                # runs onde o caso da issue falhou
OK_TOTAL=0; LINHAS_A=0; LINHAS_B=0
VERM_TODOS=0; RUNS_VERM_TODOS=0            # controle positivo: vermelho de qualquer spec
EXEC_A=0; EXEC_B=0                          # runs onde o spec apareceu no log
PARTES=()                                   # tamanho da parte 3 por run

while read -r id ts; do
  [ -z "$id" ] && continue
  JID=$(gh api "repos/$REPO/actions/runs/$id/jobs" \
        --jq ".jobs[]|select(.name|startswith(\"$PREFIX\"))|[.id,.conclusion]|@tsv" \
        2>/dev/null | tail -1)
  if [ -z "$JID" ]; then
    N_sem_job=$((N_sem_job + 1))
    echo "SKIP $id sem-job-\"$PREFIX\""
    continue
  fi
  JCONC=${JID#*$'\t'}; JID=${JID%%$'\t'*}

  LOG="$WORK/log.txt"
  HTTP=$(curl -sL -o "$LOG" -w '%{http_code}' \
         -H "Authorization: Bearer $(gh auth token)" \
         "https://api.github.com/repos/$REPO/actions/jobs/$JID/logs")
  BYTES=$(wc -c < "$LOG" | tr -d ' ')
  OK=$(n "$PAT_OK" "$LOG")
  VT=$(n "$PAT_VERM" "$LOG")
  # log sem nenhuma linha do reporter NÃO conta como "sem falha": fica
  # explícito como SKIP e sai do total (é o caso que o corpo da issue avisa)
  if [ "$HTTP" != "200" ] || [ "${BYTES:-0}" -eq 0 ] || { [ "${OK:-0}" -eq 0 ] && [ "${VT:-0}" -eq 0 ]; }; then
    N_log_ruim=$((N_log_ruim + 1))
    echo "SKIP $id sem-dados-do-report http=$HTTP bytes=$BYTES checks_ok=$OK vermelhos=$VT"
    continue
  fi

  N_total=$((N_total + 1))
  OK_TOTAL=$((OK_TOTAL + OK))
  # controle positivo da sonda: vermelho de QUALQUER spec neste log
  VERM_TODOS=$((VERM_TODOS + VT))
  [ "${VT:-0}" -gt 0 ] && RUNS_VERM_TODOS=$((RUNS_VERM_TODOS + 1))

  LA=$(nf "$SPEC_A" "$LOG"); LB=$(nf "$SPEC_B" "$LOG")
  VA=$(n "$PAT_VERM.*${SPEC_A}" "$LOG"); VB=$(n "$PAT_VERM.*${SPEC_B}" "$LOG")
  CA=$(n "$PAT_VERM.*${CASO_A}" "$LOG"); CB=$(n "$PAT_VERM.*${CASO_B}" "$LOG")
  PA=$(n "$PAT_OK.*${SPEC_A}" "$LOG");   PB=$(n "$PAT_OK.*${SPEC_B}" "$LOG")
  [ "${LA:-0}" -gt 0 ] && EXEC_A=$((EXEC_A + 1))
  [ "${LB:-0}" -gt 0 ] && EXEC_B=$((EXEC_B + 1))
  LINHAS_A=$((LINHAS_A + LA)); LINHAS_B=$((LINHAS_B + LB))
  FALHAS_A=$((FALHAS_A + VA)); FALHAS_B=$((FALHAS_B + VB))
  [ "${CA:-0}" -gt 0 ] && RUNS_CASO_A=$((RUNS_CASO_A + 1))
  [ "${CB:-0}" -gt 0 ] && RUNS_CASO_B=$((RUNS_CASO_B + 1))

  Q_FALHA=0
  if [ "${VA:-0}" -gt 0 ] || [ "${VB:-0}" -gt 0 ]; then
    Q_FALHA=1; RUNS_QUALQUER=$((RUNS_QUALQUER + 1))
    if [ "${VA:-0}" -gt 0 ] && [ "${VB:-0}" -gt 0 ]; then RUNS_AMBOS=$((RUNS_AMBOS + 1))
    elif [ "${VA:-0}" -gt 0 ]; then RUNS_SO_A=$((RUNS_SO_A + 1))
    else RUNS_SO_B=$((RUNS_SO_B + 1)); fi
  fi
  [ "${VA:-0}" -gt 0 ] && RUNS_A=$((RUNS_A + 1))
  [ "${VB:-0}" -gt 0 ] && RUNS_B=$((RUNS_B + 1))

  # tamanho da parte 3 (responde à pergunta 2 da issue: rebalanceamento #1174)
  NP=$(grep -a 'SPECS_PARTE_3:' "$LOG" | head -1 \
       | sed 's/.*SPECS_PARTE_3:[[:space:]]*//' | wc -w | tr -d ' ')
  PARTES+=("${NP:-0}")

  echo "RUN $id job=$JID conc=$JCONC bytes=$BYTES checks_ok=$OK parte3_specs=${NP:-0} | $SPEC_A linhas=$LA pass=$PA vermelho=$VA caso281=$CA | $SPEC_B linhas=$LB pass=$PB vermelho=$VB caso378=$CB"
done < "$WORK/ids.txt"

# ── resumo numérico ──────────────────────────────────────────────────────────
N_PORTE_MEDIO=0
if [ "${#PARTES[@]}" -gt 0 ]; then
  S=0; for v in "${PARTES[@]}"; do S=$((S + v)); done
  N_PORTE_MEDIO=$((S / ${#PARTES[@]}))
fi
BASE_ALT=$((RUNS_SO_A + RUNS_SO_B))
if [ "$RUNS_QUALQUER" -gt 0 ]; then
  ALT=$((100 * BASE_ALT / RUNS_QUALQUER))
else
  ALT=0
fi
INTERM_A=0; INTERM_B=0
[ "${EXEC_A:-0}" -gt 0 ] && INTERM_A=$((100 * RUNS_A / EXEC_A))
[ "${EXEC_B:-0}" -gt 0 ] && INTERM_B=$((100 * RUNS_B / EXEC_B))

echo "=== RESUMO #1218 ==="
echo "N_ids=$N_IDS  N_total=$N_total  (sem-job=$N_sem_job, sem-dados-do-report=$N_log_ruim)"
echo "janela=$JANELA_VELHA .. $JANELA_NOVA (as $N_IDS runs mais recentes do e2e.yml)"
echo "checks_ok_total=$OK_TOTAL   # soma dos ✓ contados: prova de que nenhum log vazio virou 'sem falha'"
echo "controle_positivo: vermelhos_de_qualquer_spec=$VERM_TODOS em $RUNS_VERM_TODOS runs  # a sonda enxerga vermelho quando existe"
echo "parte3_specs_media=$N_PORTE_MEDIO (specs listados em SPECS_PARTE_3 por run)"
echo "$SPEC_A: execucoes=$EXEC_A | linhas_citando=$LINHAS_A | vermelhos=$FALHAS_A | runs_com_vermelho=$RUNS_A (intermitencia=${INTERM_A}%) | runs_caso_281_vermelho=$RUNS_CASO_A"
echo "$SPEC_B: execucoes=$EXEC_B | linhas_citando=$LINHAS_B | vermelhos=$FALHAS_B | runs_com_vermelho=$RUNS_B (intermitencia=${INTERM_B}%) | runs_caso_378_vermelho=$RUNS_CASO_B"
echo "runs_com_uma_falha=$RUNS_QUALQUER | so_A=$RUNS_SO_A | so_B=$RUNS_SO_B | ambos=$RUNS_AMBOS"
echo "ALTERNANCIA = (so_A + so_B) / runs_com_uma_falha = $BASE_ALT / $RUNS_QUALQUER = ${ALT}%"
if [ "$N_total" -lt 50 ]; then
  echo "ALERTA: N_total=$N_total < 50 — amostra insuficiente para o critério (justificativa: $N_sem_job runs sem o job, $N_log_ruim logs sem dados de reporter, de $N_IDS listadas)."
fi
if [ "$RUNS_QUALQUER" -eq 0 ]; then
  echo "VEREDITO: flakiness isolada não confirmada / disputa de recurso não confirmada — ZERO falha dos dois specs em $N_total runs varridos, enquanto a mesma sonda registrou $VERM_TODOS vermelho(s) de outros specs em $RUNS_VERM_TODOS runs (controle positivo: o detector funciona). Na janela medida nenhum dos dois casos caiu, então não há o que alternar."
elif [ "$RUNS_AMBOS" -eq 0 ] && [ "$RUNS_SO_A" -gt 0 -o "$RUNS_SO_B" -gt 0 ] && [ "$ALT" -lt 60 ]; then
  echo "VEREDITO: flakiness isolada — ALTERNANCIA=${ALT}% (< 60%) num total de $RUNS_QUALQUER runs com falha; só um dos specs caiu e não há alternância mutua."
elif [ "$ALT" -ge 60 ] && [ "$RUNS_AMBOS" -ge 1 ]; then
  echo "VEREDITO: disputa de recurso (alternam) — ALTERNANCIA=${ALT}% (>= 60%): em $BASE_ALT de $RUNS_QUALQUER runs com falha caiu exatamente um dos dois."
else
  echo "VEREDITO: flakiness isolada — ALTERNANCIA=${ALT}% (< 60%) sobre $RUNS_QUALQUER runs com falha (so_A=$RUNS_SO_A, so_B=$RUNS_SO_B, ambos=$RUNS_AMBOS)."
fi
echo "FIM N_total=$N_total"
