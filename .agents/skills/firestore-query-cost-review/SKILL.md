---
name: firestore-query-cost-review
description: Revisa código que usa Firestore (ou bancos NoSQL cobrados por leitura/documento, como DynamoDB) em busca de queries e listeners em tempo real sem filtro que multiplicam o custo de leitura. Use ao escrever ou revisar qualquer getDocs, onSnapshot, query em tempo real, ou handler que reage a mudanças de coleção — especialmente em apps com múltiplos clientes conectados simultaneamente (painel admin + app do cliente).
---

# Custo de Queries em Tempo Real (Firestore / NoSQL)

Nasceu de um bug real: um app de agendamento estourou o plano gratuito do Firestore
(50 mil leituras/dia) em ~2 horas de testes leves. A causa não era um único erro óbvio,
era um padrão repetido em vários lugares do código que, combinado, multiplicava
leituras exponencialmente.

## O padrão perigoso (evite sempre)

```js
// ❌ Lê a coleção INTEIRA, sem filtro
onSnapshot(collection(db, "agendamentos"), (snapshot) => {
  // ❌ E dentro do callback, lê a coleção INTEIRA de novo
  const fresh = await getDocs(collection(db, "agendamentos"));
  ...
});
```

Por que isso é catastrófico:
1. `onSnapshot` sem `where`/`limit` já lê **todos os documentos** na primeira conexão
   e a cada nova conexão de cliente (aba aberta, reload de página, novo usuário).
2. Toda escrita em **qualquer** documento da coleção dispara o callback em **todos os
   clientes conectados simultaneamente**.
3. Se o callback faz uma nova leitura completa (`getDocs` da coleção inteira) em vez de
   usar os dados que o próprio snapshot já trouxe, o custo vira:
   `nº de documentos × nº de clientes conectados × cada escrita`.

Com poucos documentos e poucos clientes isso passa despercebido em dev. Em uso real
(ou mesmo em testes com duas abas abertas — cliente + admin), explode.

## Checklist de revisão

### 1. Todo `onSnapshot`/`getDocs` tem filtro?
Pergunte: essa tela realmente precisa da coleção inteira, ou só de um subconjunto
(data específica, usuário específico, últimos N dias, status específico)? Use `where`
para restringir sempre que possível. Coleções sem filtro só se justificam quando o
volume de documentos é comprovadamente pequeno e estável (ex: config de app, lista de
poucos barbeiros).

### 2. O callback de um listener lê de novo o que o listener já trouxe?
Se um `onSnapshot` já entrega `snapshot.docChanges()` ou `snapshot.docs`, **use esses
dados diretamente** para atualizar o estado/cache local. Nunca dispare uma nova query
completa (`getDocs`) de dentro do callback só para "ter certeza" — isso duplica o custo
do listener sem necessidade.

### 3. Múltiplos listeners fazendo a mesma pergunta?
Se duas telas (ex: painel do cliente e painel admin) escutam a mesma coleção inteira
para fins diferentes, considere se cada uma pode escutar apenas o subconjunto que
realmente usa (ex: cliente escuta só seus próprios documentos + os do dia atual; admin
escuta só um intervalo de datas relevante, não o histórico completo desde sempre).

### 4. O listener é re-registrado sem necessidade?
Verifique se um `onSnapshot`/`getDocs` é recriado a cada re-render ou a cada troca de
aba/estado, em vez de ser assinado uma única vez e reaproveitado. Assinaturas
duplicadas multiplicam leituras sem nenhum ganho.

### 5. Existe alguma leitura de coleção inteira dentro de um loop ou de outro callback?
Buscas dentro de `forEach`/`for` (uma leitura por item) devem ser substituídas por uma
única query com `where('campo', 'in', [...])` (até 30 valores) ou por batelada, quando
o banco suportar.

## Como aplicar

Antes de considerar uma feature de tempo-real pronta, liste todos os `onSnapshot` e
`getDocs`/`get` adicionados ou tocados na tarefa e responda os 5 itens acima para
**cada um**. Estime mentalmente: "com 2 abas abertas e 10 escritas seguidas, quantas
leituras isso gera?" Se a resposta crescer com o número de documentos históricos ou
com o número de clientes conectados de forma não-óbvia, é sinal de reescrever a query.
