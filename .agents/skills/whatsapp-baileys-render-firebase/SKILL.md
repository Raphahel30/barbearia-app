---
name: whatsapp-baileys-render-firebase
description: Guia de configuração, instalação e operação de um bot de WhatsApp não-oficial (Baileys) rodando dentro de um backend Node/Express hospedado no Render, com sessão persistida no Firestore. Use ao configurar, depurar ou modificar qualquer parte da conexão WhatsApp (pareamento, QR Code, reconexão, envio de mensagens) em projetos que usam @whiskeysockets/baileys + Render + Firebase.
---

# WhatsApp via Baileys + Firestore + Render

Esta skill documenta uma arquitetura real em produção (app de agendamento de
barbearia) e os incidentes reais que ela já causou. Não é teoria — cada regra aqui
existe porque algo quebrou antes por essa razão.

## 1. Entenda a arquitetura antes de mexer

Existem **duas abordagens possíveis** para WhatsApp neste tipo de projeto — não as
misture:

| Abordagem | Como funciona | Quando faz sentido |
|---|---|---|
| **Baileys direto** (`@whiskeysockets/baileys`) | Roda DENTRO do mesmo processo Node do backend. Não-oficial, gratuito, mas sujeito a bloqueios do WhatsApp. | Projetos pequenos, orçamento zero, tolerância a instabilidade ocasional. |
| **Evolution API** (imagem Docker `atendai/evolution-api`) | Serviço **separado** no Render + banco PostgreSQL próprio; o backend principal só faz requisições HTTP para ela. | Quando se quer isolar a instabilidade do WhatsApp do backend principal, ou rodar múltiplas instâncias. |
| **WhatsApp Cloud API oficial (Meta)** | API paga/oficial da Meta, sem risco de bloqueio. | Produção séria, orçamento disponível, exige aprovação da Meta e número comercial verificado. |

**Antes de escrever qualquer código**, confirme no código-fonte (não só na
documentação/README) qual dessas está realmente ativa: procure por
`makeWASocket` (Baileys direto) vs. chamadas `fetch`/`axios` para uma URL
`EVOLUTION_API_URL` (Evolution API). Documentação e `.env.example` podem descrever uma
integração que não foi de fato conectada ao código — isso já aconteceu neste projeto:
existe um guia completo de Evolution API + Postgres nos docs, mas o código real usa
Baileys direto, sem nenhuma chamada à Evolution API.

## 2. Pré-requisitos de infraestrutura

- **Node.js 20+** (Baileys 7.x exige; confirme em `engines.node` do `package.json`).
- **Um único serviço Render** (`type: web`) rodando o backend — o Baileys roda no
  mesmo processo, não em worker separado.
- **Firestore habilitado** no projeto Firebase, com uma Service Account.
- Variável de ambiente `FIREBASE_SERVICE_ACCOUNT` no Render contendo o JSON da
  Service Account (em texto puro ou Base64) — nunca commitar esse arquivo no git.

## 3. Regra de ouro: sessão TEM que persistir fora do disco local

O plano free do Render tem **filesystem efêmero**: qualquer pasta local (`.wa_session`,
etc.) é apagada a cada deploy, restart, ou quando o serviço "dorme" por inatividade e
"acorda" de novo. Se a sessão do Baileys usar `useMultiFileAuthState()` (armazenamento
em arquivos locais), o WhatsApp vai pedir para parear de novo toda vez que isso
acontecer — o que, no free tier, é frequente.

**A solução correta é persistir credenciais e chaves no Firestore**, não no disco.
Ao configurar isso do zero (ou revisar uma implementação existente), garanta que:

1. Existe um adaptador de auth state customizado para Firestore (troque
   `useMultiFileAuthState` por uma função equivalente que leia/escreva no Firestore,
   ex. `useFirestoreAuthState(firestoreDb)`), retornando `{ state, saveCreds }` na
   mesma interface que o Baileys espera.
2. **Esse adaptador está de fato importado e chamado** dentro da função que cria o
   socket (`makeWASocket`). É comum criar o arquivo do adaptador e esquecer de
   trocar a chamada — isso já aconteceu neste projeto: o arquivo `firestoreAuthState.js`
   existia pronto, mas `whatsappService.js` continuava chamando
   `useMultiFileAuthState`, then a "correção" nunca entrou em produção.
3. Chaves (`keys.set`/`keys.get`) são salvas por documento individual (uma chave =
   um documento Firestore), não como um blob único — isso evita reescrever tudo a cada
   pequena mudança e mantém os documentos pequenos.
4. Ao fazer logout voluntário, a coleção inteira de sessão no Firestore é apagada
   (não só o arquivo local), senão a próxima tentativa de pareamento reaproveita
   credenciais antigas inválidas.

**Como verificar se está funcionando de verdade:** force um restart manual do serviço
no Render (ou espere ele dormir e acordar, no free tier) e confirme que o WhatsApp
reconecta sozinho, sem pedir novo QR Code/pareamento.

## 4. Fluxo de conexão: ordem importa

Ao implementar ou revisar o código de conexão do Baileys:

1. **Registre os listeners `connection.update` e `creds.update` imediatamente após
   criar o socket** (`makeWASocket(...)`), **antes** de solicitar um código de
   pareamento (`sock.requestPairingCode(...)`) ou de esperar pelo QR Code. Um bug real
   já aconteceu aqui: os listeners só eram registrados depois do fluxo de pareamento,
   então o backend nunca via a confirmação de conexão vinda do celular, mesmo quando o
   usuário pareava com sucesso.
2. Ao gerar um **código de pareamento por número de telefone** (alternativa ao QR
   Code), normalize o número antes de chamar `requestPairingCode`: remova tudo que não
   for dígito, garanta o prefixo do país (ex. `55` para Brasil) se o número informado
   tiver 10-11 dígitos, e rejeite números claramente inválidos antes de gastar uma
   tentativa (o WhatsApp bloqueia temporariamente — `statusCode 401` — depois de
   poucas tentativas malsucedidas seguidas).
3. **QR Code e código de pareamento são fluxos mutuamente exclusivos** para a mesma
   tentativa de conexão — não dispare os dois ao mesmo tempo pro mesmo socket; isso
   cria condição de corrida entre os dois eventos de `connection.update`.
4. No handler de `connection === 'close'`, sempre verifique o `statusCode` do erro
   (via `@hapi/boom`) para diferenciar **logout deliberado** (`DisconnectReason.loggedOut`
   — não tente reconectar, limpe a sessão) de **queda de conexão transitória** (tente
   reconectar com backoff crescente, com um número máximo de tentativas para não
   martelar o WhatsApp e correr risco de bloqueio).

## 5. Estado em memória do processo

O socket ativo (`sock`), status da conexão, QR Code atual, etc. normalmente vivem em
variáveis de módulo (não em banco). Isso significa:

- **Só existe uma conexão de WhatsApp por processo Node rodando.** Não é possível
  escalar esse serviço horizontalmente (múltiplas instâncias) sem quebrar a conexão —
  cada instância tentaria autenticar como o mesmo "aparelho", gerando desconexões
  mútuas. Se o plano do Render permitir múltiplas instâncias, desative isso para o
  serviço que hospeda o WhatsApp, ou isole o WhatsApp num serviço próprio de instância
  única.
- Reinícios do processo perdem esse estado em memória (mas não a sessão do WhatsApp
  em si, se ela estiver no Firestore como descrito na seção 3) — o socket precisa ser
  recriado do zero ao subir, lendo o estado salvo.

## 6. Configuração no Render (`render.yaml` / painel)

Variáveis de ambiente mínimas para essa arquitetura:

```yaml
services:
  - type: web
    env: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: NODE_VERSION
        value: 20.18.0          # confira a versão exigida pelo Baileys em uso
      - key: FIREBASE_SERVICE_ACCOUNT
        sync: false             # cole o JSON da Service Account no painel do Render
```

Cuidados:

- Se o repositório tiver **mais de um `package.json`** (ex. um na raiz e outro em
  `server/`), confirme qual deles o `buildCommand`/`startCommand` do Render realmente
  usa antes de instalar dependências do Baileys — já aconteceu de editar o arquivo
  errado e o deploy não refletir a mudança.
- O plano free do Render "dorme" o serviço após um período de inatividade. Ao acordar,
  o processo reinicia do zero — reforça a necessidade da persistência em Firestore da
  seção 3.

## 7. Checklist antes de considerar a integração "pronta"

- [ ] A sessão sobrevive a um restart manual do serviço (testado de verdade, não só
      assumido).
- [ ] Os listeners de conexão são registrados antes de qualquer solicitação de
      pareamento/QR.
- [ ] Existe distinção clara entre logout deliberado e queda transitória no handler de
      `connection === 'close'`, com backoff e limite de tentativas na reconexão.
- [ ] Não há dois métodos de conexão WhatsApp documentados/parcialmente implementados
      ao mesmo tempo sem deixar claro qual está realmente ativo no código.
- [ ] Números de telefone são normalizados (dígitos + DDI) antes de qualquer chamada
      à API do Baileys.
- [ ] O serviço Render está configurado para instância única (sem autoscaling
      horizontal) enquanto hospedar a conexão WhatsApp.
