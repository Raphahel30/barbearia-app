# Últimas atualizações locais

Registro de 03/09/2026.

Última etapa: Pix manual gera solicitação sem reserva; aprovação na Agenda administrativa revalida e reserva atomicamente. Criação direta de agendamento pelo cliente bloqueada nas regras locais. Fallback separado do Pix automático e do WhatsApp. Testes: 24 unitários, 69 verificações WhatsApp/API e 26 no Firebase Emulator. Consulte "Continuação: Pix manual aprovado antes da reserva". Ainda não publicar; interface e integração real aguardam homologação. As entradas seguintes são históricas.

Atualização mais recente: botão de resgate gratuito integrado à confirmação autenticada no servidor, com validação de benefício/horário e transação de agenda, selos, aniversário e estoque. Testes: 24 unitários, 66 verificações WhatsApp/API e 24 no Firebase Emulator aprovados. Detalhes em "Continuação: resgate gratuito no servidor". Pagamento manual/presencial e fechamento das regras de criação continuam pendentes; não publicar. Os registros seguintes são históricos.

Avanço mais recente: consumo transacional dos benefícios de agendamentos pagos, com meta de fidelidade validada, recibo idempotente e conflito sinalizado para revisão manual. Sintaxe, 24 testes unitários, 65 verificações WhatsApp/API e 23 testes no Firebase Emulator aprovados. Consulte a seção "Continuação: consumo transacional dos benefícios" do relatório de correções. As referências abaixo descrevem etapas anteriores. Continua não aprovado para publicação.

Continuação mais recente: validação no servidor dos preços de agendamentos pagos, incluindo produtos promocionais, benefícios e taxa de reserva/cartão. Testes atuais: 24 unitários, 65 verificações WhatsApp/API, 22 testes no Firebase Emulator e sintaxe aprovados. Veja a seção "Continuação: preços dos agendamentos pagos" em [CORRECOES-2026-09-03.md](CORRECOES-2026-09-03.md). Ainda não publicar; o consumo atômico dos benefícios e os demais bloqueios registrados continuam pendentes.

Atualização posterior à revisão: consulte [CORRECOES-2026-09-03.md](CORRECOES-2026-09-03.md) para as correções efetivamente implementadas nesta retomada e as pendências restantes. A suíte WhatsApp/API passou a ter 64 verificações aprovadas; o Emulator mantém 21 testes, com cenário mensal ampliado.

Esta pasta contém a versão de trabalho mais recente das alterações realizadas nesta tarefa. Os arquivos de código, configurações e testes já estavam salvos diretamente aqui; não foram restaurados de backups nem substituídos pela versão do Claude.

Inclui as alterações locais de planos mensais/CRM, controles de segurança, pagamentos, WhatsApp, câmera/galeria e respectivos testes. Há alterações ainda não commitadas e arquivos novos ainda não rastreados pelo Git.

**Estado: não aprovado para publicação.** Salvar a versão mais recente não significa que todas as correções recomendadas foram implementadas. A última revisão identificou bloqueios de segurança e funcionamento ainda pendentes, detalhados em [REVISAO-PARA-APROVACAO-2026-09-03.md](REVISAO-PARA-APROVACAO-2026-09-03.md).

Última rodada de validação: sintaxe aprovada, 10 testes de CRM/planos, 53 verificações de WhatsApp/API e 21 testes no Firebase Emulator aprovados. Pagamentos reais/sandbox, dispositivos físicos e configuração ativa de produção ainda não foram homologados integralmente.

Nenhum commit, push ou deploy foi realizado ao salvar este registro. Nenhuma credencial foi alterada. Não distribua a pasta inteira: ela contém arquivo local de credencial Firebase. Não use o ZIP antigo da raiz como se fosse esta versão atualizada.
