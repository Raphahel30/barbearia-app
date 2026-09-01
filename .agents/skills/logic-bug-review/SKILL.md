---
name: logic-bug-review
description: Revisa lógica de backend em busca de bugs sutis (sobrescrita de estado, dupla contagem de eventos, falta de idempotência, condições de corrida) antes de considerar uma tarefa concluída. Use sempre que escrever ou revisar webhooks, handlers de pagamento, máquinas de estado (status de pedido/agendamento/assinatura), listeners de eventos, ou qualquer código que reaja a callbacks externos (webhooks, filas, sockets).
---

# Revisão de Lógica (Logic Bug Review)

Esta skill nasceu da depuração real de um app de agendamento (barbearia-app), onde
bugs sutis passaram despercebidos em código que "parecia funcionar": nenhum deles
quebrava a aplicação visivelmente, mas corrompiam dados silenciosamente. Trate essa
skill como um checklist de saída obrigatório antes de dar uma tarefa de backend como
concluída — não apenas um guia para consultar quando algo já deu errado.

## Quando usar

- Ao escrever ou revisar handlers de webhook (pagamento, WhatsApp, e-mail, filas).
- Ao implementar máquinas de estado (ex: pendente → confirmado → cancelado → reembolsado).
- Ao lidar com reconexão, retry ou reprocessamento de eventos.
- Ao revisar qualquer PR/diff antes de marcá-lo como pronto.

## Checklist de revisão

### 1. Condições sobrepostas na mesma função
Procure blocos `if` que tratam o **mesmo evento por rótulos diferentes** (ex: um
webhook que reage tanto a `status === 'cancelled'` quanto, em outro `if` mais abaixo,
a `status === 'cancelled' || status === 'refunded'`). Se dois blocos podem disparar
para o mesmo evento, pergunte: o segundo bloco pode **sobrescrever** o que o primeiro
já decidiu corretamente? Isso foi exatamente o bug real: um pagamento cancelado (nunca
cobrado) era corretamente marcado como `cancelado` no primeiro bloco, e sobrescrito
para `reembolsado` no segundo, porque `'cancelled'` aparecia nas duas condições.

**Regra prática:** cada status/evento distinto deve ser tratado em **exatamente um**
lugar. Se precisar tratá-lo em mais de um (ex: log + ação), o segundo lugar nunca deve
escrever um campo que o primeiro já escreveu com um valor diferente.

### 2. Escritas incondicionais em documentos compartilhados
Funções que fazem `update`/`set` num registro (linha do banco, documento, arquivo)
sem antes checar o estado atual daquele registro são perigosas. Pergunte: "essa função
está prestes a sobrescrever um estado que pode já ter mudado desde que o evento foi
disparado?" Prefira updates condicionais (`where status == X`) a updates cegos.

### 3. Idempotência
Todo handler de evento externo (webhook, mensagem de fila, callback de retry) deve
poder rodar **duas vezes com o mesmo payload sem efeito colateral duplicado** — porque
provedores externos frequentemente reenviam o mesmo evento. Verifique se existe uma
checagem de "já processado" antes de qualquer efeito irreversível (debitar estoque,
enviar mensagem, cobrar).

### 4. Ordem de registro de listeners/callbacks
Em código assíncrono orientado a eventos (sockets, EventEmitter, listeners de conexão),
confirme que os listeners são registrados **antes** de qualquer ação que possa disparar
o evento correspondente. Um bug real encontrado: os listeners `connection.update` só
eram registrados depois do fluxo de pareamento, então o backend nunca via a confirmação
de conexão do celular.

### 5. Estado persistido vs. estado em memória
Se o sistema guarda estado crítico só em memória do processo (variável `let`/`const`
no topo do módulo) e o ambiente de execução pode reiniciar/reescalar (containers
serverless, planos free com sleep automático, deploys), esse estado será perdido.
Pergunte: "isso precisa sobreviver a um restart? Se sim, está sendo persistido em
disco/banco, ou só em memória?"

### 6. Efeitos em cascata acidentais
Depois de uma escrita, verifique tudo que reage a ela automaticamente (triggers,
listeners em tempo real, webhooks encadeados). Um evento pode disparar uma cadeia de
reações que, juntas, produzem um resultado diferente do que cada uma isoladamente
pretendia.

## Como aplicar

Ao terminar de escrever ou revisar um trecho de lógica de estado/evento, percorra os
6 itens acima explicitamente e responda cada um antes de considerar a tarefa concluída.
Se qualquer resposta for "não tenho certeza", isso é sinal de escrever um teste ou
pedir confirmação em vez de assumir que está correto.
