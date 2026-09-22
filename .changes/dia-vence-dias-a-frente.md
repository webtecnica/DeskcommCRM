---
impacto: nada_mudou
secao: corrigido
titulo: O agente volta a encontrar horário livre quando manda o dia e o período juntos
---

Quando o modelo que atende o cliente pedia um dia específico e, na mesma chamada, quantos dias olhar a partir de hoje (os dois campos preenchidos ao mesmo tempo), a consulta de horários livres recusava a chamada e voltava vazia sem sequer chegar ao banco. O agente então não achava nenhum horário, e a conversa terminava sem resposta ao cliente — mesmo com a agenda inteira livre.

Agora a chamada com os dois campos é aceita: vale o dia específico, que é o mais preciso dos dois. O texto que o modelo lê antes de chamar a ferramenta passa a dizer, nos dois campos, que é para mandar um ou outro — e que mandar os dois não é erro, é o dia que vence. Nada muda para quem só manda um dos campos.

Nada para fazer na VPS.

Contribuição de @webtecnica (#PR).
