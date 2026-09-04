# Revisão para aprovação — EMAÚS Barbearia

Data: 03/09/2026. Decisão: **NÃO APROVADO PARA PUBLICAÇÃO**.

Atualização: houve correções após esta revisão. Este relatório preserva o diagnóstico original; consulte [CORRECOES-2026-09-03.md](CORRECOES-2026-09-03.md) para o estado mais recente. A aprovação de publicação continua pendente.

Projeto local: `C:\Users\PC NOVO\Desktop\LOCAL SITE\barbearia-app`.
Base Git local: `4669a17`, com alterações não commitadas e novos arquivos de implementação/teste ainda não rastreados.

## Escopo e limites

Revisão do código e das configurações locais dos fluxos de agendamento, planos, pagamentos, faturamento, autenticação, WhatsApp, fotos e publicação. As fronteiras tela → API → banco foram cruzadas por inspeção e pelos testes disponíveis. Não se deve confundir isso com homologação completa em navegador, dispositivo físico ou serviços reais.

Nenhum código foi alterado nesta revisão. Nenhum commit, push, deploy, cobrança real ou alteração de dados de produção foi realizado. O único documento novo é este relatório; os testes geraram seus artefatos locais normais.

GitHub remoto, regras efetivamente publicadas no Firebase, credenciais/configuração ativa no Render e Vercel e logs desses ambientes **não foram revalidados nesta rodada**. As observações sobre hospedagem abaixo decorrem da configuração local, salvo o teste HTTP local descrito explicitamente.

## Evidências de teste desta rodada

- `npm run test:syntax`: aprovado, incluindo 7 blocos JavaScript inline dos HTMLs.
- `npm test`: código de saída 0; inclui 10 testes de CRM/planos, verificações de antecedência, verificações de lógica de pagamentos e 53 verificações de WhatsApp/API.
- `npm run test:firebase`: 21 testes aprovados, 0 falhas, 6 suítes; execução isolada em projetos demo. Inclui concorrência no consumo da mesma semana e repetição idempotente do agendamento mensal gratuito.
- `git diff --check`: sem erros de whitespace; avisos de conversão LF/CRLF.
- Probe HTTP em servidor temporário ligado apenas a `127.0.0.1`, com `NODE_ENV=test`: HEAD de `/server/src/monthlyBooking.js` e `/firebase-service-account.json` retornou **200**. Apenas status/cabeçalhos consultados; conteúdo da credencial não foi lido nem exibido. Processo temporário encerrado.

Os testes de WhatsApp são simulados/offline. Os testes de assinatura do webhook não fazem uma cobrança. A suíte atual não cobre todas as permissões e jornadas autenticadas descritas abaixo.

## Bloqueios e correções recomendadas, em ordem

### 1. Crítico — servidor publica arquivo de credencial local

**Evidência:** `server/src/server.js:331` usa `express.static` sobre a raiz do projeto. Há `firebase-service-account.json` nessa raiz e o HEAD local retornou 200 sem autenticação. Os ignores do Firebase/Vercel não protegem arquivos servidos diretamente pelo Express.

**Impacto:** um arquivo de credencial presente nesse diretório pode ser disponibilizado pelo servidor. A exposição em produção ainda não foi confirmada.

**Correção:** servir somente uma pasta de distribuição com arquivos públicos selecionados; manter credenciais fora dela e bloquear arquivos internos. Testar que credenciais, código do servidor e arquivos de backup retornem 404/403. Verificar exposição nos ambientes ativos; se a chave tiver sido exposta, revogar/substituir e investigar uso. Não basta retirar do Git.

### 2. Alta — registros financeiros ainda podem ser forjados pelo cliente

**Evidência:** `firestore.rules:56` permite criar agendamento não mensal com o próprio UID sem restringir campos financeiros/status. A atualização em `:61` permite declarar reembolso. `pagamentos_pendentes`, em `:247`, permite criação, exclusão e alteração de status pelo dono; `server/src/server.js:2068` lê esses registros para controlar processamento, tipo e dados do pagamento.

**Impacto:** valores/estados contábeis podem ser falsificados; a exclusão/recriação ou alteração de estados pode comprometer as garantias de processamento único. A API ainda consulta o Mercado Pago, portanto isto não equivale a demonstrar uma cobrança falsa aprovada pelo provedor.

**Correção:** pedidos e registros de pagamento exclusivamente pelo servidor; cliente apenas lê seu pedido e solicita ações por API. Validar UID, identificação do pedido, valor, moeda e estado do provedor contra pedido imutável. Incluir testes adversariais de criação, exclusão, reprocessamento e falsas marcações de reembolso.

### 3. Alta — dados do cliente entram no HTML do administrador sem escape

**Evidência:** `admin.html:7309` obtém nome do perfil; em `:7358` e linhas seguintes, foto/nome são interpolados no HTML. `firestore.rules:30` permite ao cliente editar nome e foto. A galeria em `admin.html:11769` também interpola textos/atributos e manipuladores inline.

**Impacto:** risco de XSS persistente no painel ao exibir campos preparados por usuário. Não foi executado payload no navegador nem nos dados reais.

**Correção:** renderizar texto com `textContent`, validar URLs e criar atributos/eventos por APIs DOM; eliminar concatenação de dados em `innerHTML`/`onclick`. Adicionar testes com caracteres especiais e entradas hostis. CSP é defesa adicional, não substitui a correção.

### 4. Alta — preço de agendamento comum não é recalculado no servidor

**Evidência:** `validarCheckoutMensal`, em `server/src/server.js:1121`, retorna sem validar agendamentos que não são planos/extras. As rotas usam `transaction_amount` e dados enviados pelo cliente; há validação específica para produto, mas não uma validação equivalente completa para o serviço comum.

**Impacto:** um cliente pode enviar valor positivo inferior ao devido ou metadados financeiros incoerentes com o catálogo.

**Correção:** enviar IDs/quantidades, recalcular serviço, adicionais, produtos, descontos, taxa de reserva e cartão no servidor e rejeitar divergências antes de criar cobrança. Benefícios de fidelidade/aniversário também precisam de autorização no servidor.

### 5. Alta — vínculo de plano legado usa e-mail sem exigir confirmação

**Evidência:** `server/src/server.js:3513` usa o e-mail do token para procurar/migrar assinatura; o middleware valida o token, mas não exige `email_verified`. A posse de um token de conta não demonstra por si só a posse da caixa de e-mail.

**Impacto:** risco de vincular uma assinatura cadastrada manualmente a uma conta criada com e-mail ainda não confirmado.

**Correção:** exigir e-mail verificado apenas para a vinculação por e-mail, ou vincular previamente pelo administrador ao UID correto; preservar o acesso por UID já estabelecido. Testar conta não verificada, conta verificada, ambiguidade e tentativas concorrentes de vínculo.

### 6. Alta — cancelamento, crédito mensal e notificação não formam um fluxo confiável

**Evidência:** `index.html:5787` chama a liberação da semana depois de cancelar/liberar o horário, captura falha apenas com aviso no console e pode continuar exibindo sucesso. `server/src/server.js:3638` exige cancelamento prévio e calcula antecedência na hora de processar essa segunda chamada. `index.html:5803` chama a notificação com token de cliente; `server/src/server.js:3026` exige chave interna/admin. O frontend não verifica `response.ok` nessa notificação.

**Impacto:** semana pode continuar consumida após cancelamento; uma repetição atrasada pode mudar o resultado da regra das três horas; WhatsApp pode não ser enviado sem aviso ao usuário.

**Correção:** uma operação autenticada de cancelamento no servidor com validação de titularidade e atualização transacional da agenda/slot/semana. Registrar instante confiável da solicitação e tratar estorno como processo idempotente. Notificações devem sair dos dados confirmados do servidor, com fila/repetição e erro observável, nunca expondo chave interna ao navegador.

### 7. Alta — faturamento não preserva corretamente histórico e estornos

**Evidência:** `admin.html:6385` calcula receitas mensais a partir da assinatura atual. A renovação em `server/src/server.js:2392` substitui o documento da assinatura. Nos ramos de estorno, como `admin.html:6500`, o valor entra em `totalEstornos`, mas não no bruto; em `:6637` é novamente subtraído do bruto.

**Impacto:** renovação pode fazer a receita de mês anterior desaparecer da tela; uma venda totalmente reembolsada, sozinha, pode produzir resultado negativo em vez de zero. Isto é problema de cálculo/histórico, mesmo que a aba abra.

**Correção:** manter lançamentos imutáveis por pagamento e por estorno, separados do estado atual do plano. Definir receita bruta, receita líquida e datas de competência/caixa de forma consistente. Testar renovação, estorno integral/parcial e movimentações entre meses.

### 8. Alta — webhook aceita processamento sem validar assinatura quando falta configuração

**Evidência:** em `server/src/server.js:2525`, toda validação HMAC depende de `if (MP_WEBHOOK_SECRET)`. Se não houver secret, segue para a consulta do pagamento.

**Impacto:** falta de configuração remove a autenticação da origem. A consulta posterior ao provedor continua existindo, mas não substitui a proteção do webhook.

**Correção:** em produção, falhar de forma fechada quando o secret não estiver configurado; adicionar teste dessa condição, assinatura expirada, duplicação e recuperação após falha.

### 9. Média — configuração versionada não garante persistência da sessão WhatsApp

**Evidência:** `server/src/whatsappService.js:11` usa diretório local `.wa_session` por padrão; `render.yaml` não configura disco nem `WA_SESSION_DIR` persistente.

**Impacto:** a configuração do repositório não demonstra sobrevivência da sessão à substituição da instância/deploy. A configuração ativa do Render não foi consultada nesta rodada.

**Correção:** confirmar a infraestrutura real e escolher armazenamento de sessão persistente compatível com o serviço. Homologar reinício/reconexão sem mensagens duplicadas. Qualquer alteração de plano/custo exige decisão do responsável.

### 10. Média — limites entre administrador e master precisam ser explícitos

**Evidência:** `/api/admin/conceder`, em `server/src/server.js:584`, aceita qualquer admin. O mesmo ocorre na remoção, exceto a proteção do usuário que possui claim master; as regras também permitem a qualquer admin escrever em `administradores`.

**Impacto:** o admin não-master consegue conceder acesso administrativo. Isso pode divergir da separação de responsabilidades desejada, embora a regra de negócio exata ainda precise ser confirmada.

**Correção:** definir matriz de permissões; se gestão de administradores for exclusiva do master, exigir claim master no backend e impedir escrita direta nessa coleção por admins comuns. Testar separadamente master, admin e cliente.

## Fotos e WhatsApp manual

- Câmera e Galeria estão separadas no HTML. Há limite de 8 MB na seleção, compressão e validação JPEG no backend; salvar/excluir exige administrador.
- Isso não comprova compatibilidade real com Android/iPhone, HEIC, orientação, cancelamento do seletor, interrupção de rede e exclusão. Esses casos ainda precisam de homologação física/navegador.
- Fotos vinculadas a um ID legado de CRM, em vez do UID autenticado, precisam de teste de visibilidade no perfil; a leitura do cliente é restrita ao UID.
- A opção manual consulta o status público e fica oculta se o estado for desconhecido. Os estados sem conexão incluem `disconnected`, `connecting` e `qr_ready`; falta testar a jornada de agendamento, compra e assinatura com conexão e sem conexão reais.

## Critérios para aprovação final

1. Corrigir os bloqueios críticos/altos e adicionar testes de regressão para cada um.
2. Homologar conta cliente, admin não-master e master em ambiente isolado.
3. Executar compra Pix/cartão em sandbox, confirmação, repetição do webhook, falha entre etapas, cancelamento, estorno e reconciliação contábil.
4. Testar plano pago/manual, vínculo de identidade, semana vigente, extras, concorrência, cancelamento antes/depois de três horas e renovação.
5. Validar galeria no celular e WhatsApp conectado/desconectado sem disparos reais não combinados.
6. Inspecionar configurações e logs ativos de Firebase/Render/Vercel/GitHub, sem revelar valores de segredos; conferir arquivos publicados e dependências. Auditoria atualizada de vulnerabilidades de dependências não foi executada nesta rodada.
7. Preparar pacote público restrito, incluir os novos arquivos no versionamento, revisar diff, definir sequência de implantação e rollback. Não enviar regras que bloqueiem o cliente antes de o fluxo compatível estar disponível.

**Conclusão:** os testes atuais dão evidência útil, mas não são suficientes para liberar esta versão. A aprovação está bloqueada pelos achados acima e pela homologação externa pendente.
