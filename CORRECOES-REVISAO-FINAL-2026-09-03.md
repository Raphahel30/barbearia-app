# Correções da última revisão — 03/09/2026

Alterações salvas nesta pasta. Sem commit, push, publicação, cobrança real ou alteração de dados de produção. Este documento registra esta rodada; não substitui a lista de pendências gerais dos relatórios anteriores.

## Corrigido nesta rodada

1. Privacidade da grade: a confirmação de pagamento escreve somente campos públicos em `slots_agendamentos`, substituindo o documento sem mesclar dados pessoais anteriores. Identificação do cliente/pagamento permanece na coleção privada.
2. Checkout mensal: preço do plano vem do catálogo; adicionais exigem assinatura ativa, semana disponível e preço recalculado, incluindo a taxa de cartão configurada. Indicadores de plano com tipo inválido são rejeitados. A confirmação paga registra `isPlano`/`semanaPlano` e consome a semana na transação da reserva.
3. Regras Firestore: cliente não pode criar, alterar ou apagar slots/proprietários diretamente. Mesmo o administrador pelo SDK cliente só escreve campos públicos na grade. A solicitação de Pix manual continua sem reservar horário até a aprovação pela API.
4. Cancelamento avulso: implementada a função de estorno que estava ausente. O cancelamento é persistido antes de chamar o Mercado Pago. Repetições usam a mesma chave de idempotência; falha mantém estorno pendente, sem anunciar devolução concluída. Pagamentos externos/manuais ficam para conferência.
5. Estoque: devolução usa evidência do débito e marca os registros na mesma transação. O endpoint legado não incrementa estoque novamente e recusa agendamento ativo. Novas confirmações gratuitas/manuais registram o débito atômico; o débito posterior de compras pagas verifica se a reserva ainda está confirmada.
6. Fidelidade: devolve a quantidade efetivamente consumida no recibo (por exemplo, cinco selos), não uma meta padrão de dez. Repetir cancelamento não restitui novamente. Sem recibo confiável, sinaliza conferência em vez de inventar saldo.

Também preserva slots de outra reserva do mesmo cliente e impede que a confirmação de pagamento recrie agendamento já cancelado.

## Verificação executada

- Sintaxe: aprovada, incluindo sete blocos inline HTML/JS.
- Testes unitários: 24 aprovados.
- Suíte WhatsApp/API: 70 verificações aprovadas, com envio simulado.
- Firebase Emulator: 36 testes aprovados, seis suítes, zero falhas.
- Regressões novas: preço mensal adulterado, extras sem assinatura/semana disponível, indicadores inválidos, devolução de cinco selos, estoque sem duplicação, estorno com timeout/repetição e mesma chave, reserva nova preservada, legado sem prova de consumo e negação de dados pessoais no slot mesmo para administrador.
- `git diff --check`: sem erros; somente avisos de normalização LF/CRLF.

## Limites e próxima validação

- O estorno foi exercitado com substituto simulado, não com transação real nem com conta sandbox do Mercado Pago. A confirmação paga via webhook e o consumo de semana com extras ainda precisam de homologação integrada com o gateway.
- Não foi feita nesta rodada a homologação visual completa no navegador/celular, nem auditoria dos ambientes publicados GitHub/Firebase/Render/Vercel.
- Registros antigos sem recibo de benefício, prova de débito ou titularidade inequívoca do slot ficam sinalizados para conferência administrativa. Nenhuma migração em produção foi executada.
- Dados pessoais eventualmente existentes na grade de produção precisam da migração controlada; alterar o código/regras não os apaga retroativamente.
- Publicar backend, frontend compatível e regras coordenadamente, somente após aprovação e homologação. Os demais pontos gerais dos relatórios anteriores não estão automaticamente encerrados.
