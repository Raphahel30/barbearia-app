# Homologação isolada

Este ambiente não publica o site, não usa contas reais e não valida o gateway Mercado Pago. O iniciador exige Auth e Firestore Emulator com o projeto `demo-emaus-local`, desconsidera credenciais de produção e serve as páginas com configuração Firebase substituída somente em memória. O servidor publicado continua com sua configuração original.

## Executar

Na pasta deste projeto, com Node e Java 21 disponíveis:

```powershell
npm run dev:emulator
```

Se o Java não estiver no PATH nesta máquina:

```powershell
$env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
$env:TEMP='C:\jtmp'
$env:TMP='C:\jtmp'
npm run dev:emulator
```

Abra **http://127.0.0.1:3000** (cliente) ou **http://127.0.0.1:3000/admin.html** (painel). Use exatamente `127.0.0.1`: nesta verificação, `localhost:3000` respondeu com outro aplicativo.

- Cliente fictício: `cliente@example.test`
- Administrador fictício: `admin@example.test`
- Senha de ambos: `TesteLocal123!`
- Se solicitado, complete o telefone fictício com `11900000000`.

Nunca use credenciais reais. As contas e alterações ficam no emulador, sem exportação persistente; encerrar e reiniciar começa uma nova sessão. Feche as abas antes de reutilizar a porta com outro servidor. Encerre com Ctrl+C. Não use `npm start` para esta homologação: o início normal não é o ambiente isolado.

O cabeçalho amarelo identifica a homologação. Service Worker/PWA, redefinição de senha, cartão, conexão WhatsApp, OAuth e outras integrações externas estão bloqueados. Imagens externas podem não aparecer pela política de segurança. Os módulos públicos do Firebase ainda são carregados de gstatic.com, mas Auth e banco usam os emuladores locais.

## Verificações em 03/09/2026

- Navegador: login de cliente, conclusão de perfil fictício, plano ativo e reserva de 04/09 às 14h pela aba Planos, com semana 1 marcada como agendada.
- Navegador: cliente sem acesso administrativo; login do administrador autorizado e painel com um agendamento registrado.
- `npm run test:local`: teste HTTP real contra a API e os dois emuladores, com autenticação cliente/admin, reserva mensal, solicitação Pix sem ocupação antecipada, bloqueio de aprovação pelo cliente, exigência de confirmação do pagamento pelo admin e reserva após aprovação. Não há cobrança nesse teste.
- `npm run test:syntax` e `npm test`: aprovados (24 unitários e 70 verificações WhatsApp/API).

## Pendências que não devem ser confundidas com aprovação para publicar

1. `/api/cliente/minha-assinatura` é chamada pelo frontend, mas não está registrada no backend atual. O navegador usou a leitura alternativa da assinatura pelo UID. Isso não comprova o vínculo automático de assinaturas cadastradas pelo admin com outro identificador; revisar/restaurar essa rota e testar esse cenário antes de publicar.
2. Cartão, checkout pago de extras e estorno precisam de homologação separada no sandbox do Mercado Pago. O bloqueio de rede deste ambiente é intencional; não é uma simulação completa do provedor.
3. Galeria/celular, todos os fluxos do painel e ambientes publicados não foram homologados nesta rodada.

O teste HTTP encerra sozinho:

```powershell
npm run test:local
```

Não execute simultaneamente com `dev:emulator`, pois usam as mesmas portas 3000, 8080 e 9099.
