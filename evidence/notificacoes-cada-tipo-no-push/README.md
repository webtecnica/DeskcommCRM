# Avisos do celular, um tipo por vez — prova pela tela

Duas capturas do PR #4310, feitas pela própria suíte e2e
(`tests/e2e/notificacoes-cada-tipo-no-push.spec.ts`, helper `captura()`), no head
`15826edf5a`. Não são mock: é a tela **Configurações › Notificações** com o
servidor respondendo o estado gravado do aparelho.

![Antes: todos os tipos ligados no Push](01-antes.png)

**01-antes.png** — o estado de chegada: cada tipo de aviso tem o seu interruptor
de Push, todos ligados. É o que o aparelho recebe antes de o usuário escolher
qualquer coisa.

![Depois: só "Lead atribuído a você" ligado](02-so-lead-atribuido.png)

**02-so-lead-atribuido.png** — depois de desligar "Nova mensagem", "A IA passou
uma conversa para a equipe" e "Negócio entrou numa etapa que avisa": sobra só
"Lead atribuído a você", ligado e habilitado, com a frase que explica a regra
("Cada aviso liga e desliga sozinho no Push"). O aparelho continua inscrito — o
teste exige que nenhum `DELETE` de inscrição tenha saído.

Reproduzível: rodar o spec de novo regrava as duas capturas. O que elas provam é
o estado da tela, não um payload de API.
