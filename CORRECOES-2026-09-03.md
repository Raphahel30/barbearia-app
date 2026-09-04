# Correções retomadas — 03/09/2026

Estado: **etapa local corrigida e testada; publicação ainda não aprovada**.

## Continuação: Pix manual aprovado antes da reserva

- Regra definida pelo proprietário: **solicitação manual não reserva horário; somente aprovação administrativa reserva**. O Pix online confirmado pelo Mercado Pago continua no fluxo automático existente. WhatsApp não determina esse comportamento.
- Nova solicitação autenticada em `solicitacoes_pix_manual`, com preço validado e identidade do token. Enviar o pedido não grava agenda/slot, não lança venda e não consome saldo/estoque. O cliente recebe aviso de que o horário não está garantido.
- Na Agenda do administrador, a seção "Pix manual — solicitações sem reserva" lista até 100 pendências por consulta. Aprovar exige confirmação explícita de conferência do recebimento; rejeitar não realiza estorno. O administrador deve comunicar a decisão ao cliente nesta versão.
- Aprovação transacional revalida preço total, horário, profissional, benefícios e estoque. Conflito preserva o pedido pendente e não cria reserva. Aprovação repetida não duplica agendamento/débito; auditoria registra solicitação, administrador e instante de aprovação. Rejeição repetida é segura.
- O antigo atalho `concluirPagamentoComSucesso('manual')` não confirma mais agenda/pagamento. As regras agora negam criação direta de agendamentos por clientes; criação administrativa de balcão continua disponível. A nova fila não aceita escrita direta nem pelo SDK administrativo do navegador: decisões passam pela API.
- Fallback visual não aparece para todo erro: depende do sinal explícito de Mercado Pago não configurado/credencial não autorizada. Validação recusada, resposta sem confirmação segura e falha de rede não sugerem segundo pagamento. Sem o servidor disponível, não é possível enviar a solicitação.
- Este novo pedido manual cobre **agendamento avulso**. Planos, adicionais mensais e produtos avulsos não são confirmados pelo antigo atalho inseguro: a interface orienta pagamento online ou contato com a barbearia. O cadastro administrativo já existente de mensalistas permanece.
- Verificação: sintaxe e diff aprovados; **24 testes unitários**, **69 verificações WhatsApp/API** e **26 testes no Firebase Emulator** aprovados. Testados ausência de reserva ao solicitar, aprovações concorrentes, repetição, rejeição, preço alterado, acesso privado e proibição de gravação direta. Testes de servidor/banco simulado não substituem homologação visual do painel, Mercado Pago sandbox e devolução real.
- Próximas pendências: homologar a nova interface e comunicar decisões; concluir proteção do cancelamento/slots e campos financeiros ainda graváveis pelo cliente, reconciliar estoque/financeiro e tratar devoluções. Nenhum commit, push, deploy ou alteração em produção foi realizado. Backend, páginas e regras precisarão de publicação coordenada após aprovação.

Esta seção substitui as pendências anteriores de criação direta de agendamento e do atalho Pix manual. Não é uma aprovação geral para publicação.

## Continuação: resgate gratuito no servidor

- O botão de confirmação gratuita usa `/api/cliente/agendar-gratuito`, com autenticação existente. Removidos desse caminho a criação da agenda, o desconto de selos e a marcação do aniversário pelo navegador. Mantidas a arquitetura Firebase/Express e a interface existente, conforme as orientações de manutenção de sites.
- Novo `server/src/freeBooking.js` lê catálogo, perfil, saldo, expediente, bloqueio do dia e profissionais no servidor. Só aceita total realmente zero com benefício válido; preços, identidade e descontos enviados não são autoridade. Agenda, slot, recibo de benefício e estoque dos produtos incluídos são gravados na mesma transação.
- Identificador de tentativa permite repetir uma resposta perdida sem novo débito. O retorno usa os dados canônicos do servidor. Notificações partem do servidor após a gravação; falhas são avisadas, sem fila durável ou garantia de reenvio.
- Verificação: sintaxe e diff aprovados; **24 testes unitários**, **66 verificações WhatsApp/API** e **24 testes no Firebase Emulator** aprovados. Novo cenário cobre gratuidade falsa, horário passado/fora da grade, dia bloqueado, concorrência, estoque, repetição, saldo e escolha de profissional. O acesso sem login à nova rota foi testado. Não houve teste visual em navegador/celular nesta etapa.
- Esta é a migração do **resgate gratuito**, não a conclusão de todos os agendamentos avulsos. O fallback Pix manual e pagamento presencial ainda precisam de um fluxo próprio que não confunda declaração do cliente com pagamento comprovado. As regras ainda permitem criar agendamento comum diretamente; não foram fechadas nesta etapa para não interromper os caminhos ainda não migrados. Logo, ainda há bloqueio de segurança para publicação.
- Cancelamento/restituição de benefícios e estoque, homologação da interface, reserva dos benefícios antes de cobranças e demais pendências anteriores continuam abertos. Nada foi publicado nem alterado no banco de produção.

## Continuação: consumo transacional dos benefícios

- Criado `server/src/bookingBenefits.js`. Na confirmação de agendamentos pagos, fidelidade e aniversário são consumidos na mesma transação de agenda/slot. Todas as leituras precedem as escritas; falha aborta o conjunto.
- Removido o débito fixo de 10 selos. Usa a meta validada e persistida no checkout. Atualiza saldo, contador e disponibilidade; aniversário usa o ano do orçamento, não o ano local do processo.
- Recibo privado em `resgates_beneficios/{paymentId}` impede débito duplicado. A coleção não possui permissão para o SDK cliente nas regras atuais. Leitura do agendamento dentro da transação protege contra repetição concorrente da confirmação.
- Saldo insuficiente, aniversário já resgatado ou benefício legado sem orçamento validado produzem `conflito_beneficio` no pagamento, com `requerResolucaoManual: true`. Não confirma agenda nesse caso nem declara estorno efetuado. Checkouts de planos não aceitam os benefícios avulsos.
- Testes: sintaxe e diff conferidos, 24 testes unitários e 65 verificações WhatsApp/API aprovados; Firebase Emulator com **23 testes aprovados**. Novo cenário cobre meta de 5, saldo remanescente, aniversário concorrente, repetição, outro proprietário, orçamento legado, fidelidade concorrente e rollback sem débito. São testes do módulo transacional em banco simulado, não cobrança real/ponta a ponta.
- Pendências: reservar benefícios antes da cobrança para reduzir conflitos de pagamentos já aprovados; exibir/tratar esse conflito no fluxo completo de atendimento e homologar resolução/estorno. Agendamentos gratuitos/manuais ainda usam caminhos legados; estoque e notificações posteriores à confirmação ainda precisam de reconciliação. A gravação direta de agendamentos pelo cliente continua sendo bloqueio de publicação.

Esta seção supera a pendência de débito fixo/consumo não atômico dos benefícios pagos registrada na etapa anterior. Nenhum deploy, commit, push ou alteração em dados de produção foi realizado.

## Continuação: preços dos agendamentos pagos

- Criado `server/src/bookingPricing.js` e conectado aos checkouts Pix e cartão de agendamentos comuns. Recalcula serviço, adicionais, produtos, promoções, benefícios, taxa de reserva e acréscimo de cartão usando catálogo/configurações e perfil/saldo do banco. Valor divergente é rejeitado antes da criação do pagamento.
- Produtos adicionais respeitam a promoção do dia da compra em Brasília; serviços respeitam a data do atendimento. Preços, nomes e descontos enviados pelo navegador não são autoridade. Rejeita adicionais repetidos, produto sem estoque, catálogo ambíguo e datas/valores inválidos.
- O preço líquido do atendimento é persistido para o cálculo posterior do saldo. Corrigida referência a `cardholderName` inexistente no fallback do metadata do cartão.
- Verificação desta continuação: sintaxe aprovada; **24 testes unitários**, verificações de antecedência/pagamentos e **65 verificações WhatsApp/API** aprovados; **22 testes no Firebase Emulator** aprovados. O novo cenário Emulator lê catálogo/saldo persistidos, rejeita preço adulterado e detecta alteração de preço e saldo insuficiente. Não faz cobrança no Mercado Pago.
- Limites importantes: o cálculo não reserva estoque ou benefícios durante o checkout. O consumo de fidelidade no pós-pagamento ainda usa meta fixa de 10, precisa usar a meta validada e ser atômico/idempotente com o agendamento; aniversário também precisa desse tratamento. A correspondência entre o tipo de cartão declarado e o retornado pelo provedor ainda precisa ser verificada. Promoções com frações de centavo precisam ser alinhadas entre a interface legada e o cálculo em centavos. Pagamentos em dinheiro/benefícios totalmente gratuitos e gravações diretas no Firestore continuam pendentes de migração.
- Por essas pendências e pelas demais listadas abaixo, esta etapa **não libera publicação**. Não houve commit, push, deploy ou mudança em dados de produção.

## Continuação: segurança da interface

- Criado `assets/ui-safe.js`, compartilhado pelas duas páginas: codificação de textos/atributos, tratamento de argumentos dos controles legados e validação de URLs de imagem.
- Cartões das galerias principal do administrador e do cliente agora usam elementos DOM, `textContent` e callbacks; não inserem nomes, estilos, observações ou URLs em comandos JavaScript/HTML. Download e visualização validam a URL.
- Protegidos os campos da galeria do CRM, sugestões de clientes, rótulo de seleção e opções de barbeiro. A agenda desktop/mobile passou a codificar nome, telefone, serviço, profissional, horário, imagem e argumentos dos botões.
- A primeira edição atingiu um bloco maior do que o pretendido. Ela foi revertida pelos diffs exatos registrados nesta tarefa, preservando as alterações anteriores, e reaplicada com limites específicos. Sintaxe e diff foram conferidos depois da restauração.
- Novos testes de segurança: 5/5 aprovados, incluindo entradas com tags/eventos, aspas, entidades HTML, esquemas de URL perigosos e preservação das ações dos botões. São testes locais de funções/DOM simulado, não homologação visual em navegador real.
- `npm test` aprovado: agora são 15 testes unitários de CRM/planos/interface e 65 verificações WhatsApp/API, além das verificações existentes de antecedência/pagamentos. Sintaxe aprovada. O módulo público novo também foi verificado por HTTP. Não houve mudança nas regras/banco nesta continuação; o resultado anterior do Emulator continua registrado abaixo e não foi reexecutado nesta etapa.
- A correção de XSS ainda não é uma certificação de todo o HTML: outras telas legadas (por exemplo, mensalistas, fidelidade e produtos) ainda precisam da mesma revisão. As pendências de preços, agendamentos comuns, cancelamento avulso, histórico financeiro e homologação externa continuam abertas.

Todos os arquivos desta etapa estão salvos em `C:\Users\PC NOVO\Desktop\LOCAL SITE\barbearia-app`. O relatório de revisão anterior é histórico; este documento registra o avanço posterior.

## Implementado nesta etapa

- Express serve somente uma lista explícita de páginas, imagens, manifestos, CSS e service worker. Credencial Firebase, código do servidor, regras, package.json, .env e ZIP retornam 404 nos testes; páginas públicas continuam em 200. A credencial não foi excluída, lida nem substituída.
- `pagamentos_pendentes`: cliente pode ler o próprio registro, mas não criar, alterar estados/dados ou excluir. Fechar o modal Pix limpa apenas a interface local e explica que isso não cancela um pagamento já efetuado.
- Webhook sem secret retorna 503, em vez de seguir sem validar a assinatura. Removido log de prefixo do token de pagamento.
- Vínculo de assinatura legada por e-mail exige `email_verified` no token. Plano já vinculado ao UID continua acessível. A tela sem plano oferece envio de confirmação de e-mail e orienta entrar novamente após confirmar.
- Cancelamento mensal agora reúne agenda, slot e semana em uma transação no servidor, com validação do proprietário e antecedência calculada no servidor. Repetição não desconta duas vezes. Nova reserva após cancelamento recebe versão de ID diferente: uma repetição antiga não cancela a nova reserva.
- A notificação do cancelamento mensal sai do servidor após a confirmação. Falha/offline produz aviso; não há garantia de entrega nem fila durável de reenvio. Estorno de extras não é anunciado como realizado.
- No cancelamento avulso, a interface só declara estorno confirmado quando a API retorna sucesso; falha HTTP da notificação deixa de ser silenciosa. A migração integral desse fluxo para o servidor ainda está pendente.
- Faturamento: recompõe o bruto com os valores dos ramos estornados antes de subtrair os estornos, evitando a dupla redução identificada. Isso não resolve, por si só, histórico de renovações nem todos os casos de estorno parcial.

## Verificação

- Sintaxe aprovada: 7 blocos JS inline e verificações Node.
- `npm test`: aprovado; 10 testes de CRM/planos, verificações de antecedência/pagamentos e **64 verificações de WhatsApp/API**, incluindo arquivos públicos/privados e webhook sem secret.
- Firebase Emulator: **21 testes aprovados**. O cenário mensal foi ampliado com cancelamento transacional, tentativa por outro usuário, crédito antes/depois de três horas, reagendamento e repetição antiga que preserva a nova reserva.
- `git diff --check`: sem erro de whitespace; somente avisos LF/CRLF.

## Pendências obrigatórias antes de publicar

1. Restringir também a criação e os campos financeiros dos agendamentos comuns; para não quebrar reservas legítimas, migrar seu fluxo para uma API autoritativa junto com as regras.
2. Completar o fluxo financeiro autoritativo: cálculo dos checkouts pagos implementado acima; faltam reserva/consumo atômico de benefícios e estoque, migração de agendamentos gratuitos/manuais, arredondamento consistente com a interface e homologação do cartão.
3. Corrigir a interpolação insegura de dados no HTML do painel/galeria (XSS).
4. Migrar cancelamento avulso e notificações para operação autenticada no servidor; tratar reconciliação/reenvio e estornos de extras.
5. Preservar histórico financeiro por pagamento/renovação e homologar estornos parciais.
6. Verificar os pacotes publicados de Firebase/Vercel, além do bloqueio Express já implementado; confirmar eventual exposição anterior da chave e substituir se necessário, com autorização para produção.
7. Confirmar permissões exclusivas do master e persistência da sessão WhatsApp, sem presumir mudança de custo/plano de hospedagem.
8. Homologar e-mail/vínculo autenticado, celular/galeria, pagamentos sandbox e configurações reais de produção.

Não houve commit, push, deploy, cobrança real ou alteração de dados de produção. Não publicar isoladamente as regras sem a versão compatível do frontend/backend. Não usar o ZIP antigo como versão atualizada.
