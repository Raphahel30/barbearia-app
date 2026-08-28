import fs from 'fs';

const html = fs.readFileSync('admin.html', 'utf8');

const idsToCheck = [
  'containerGradeCalendarioAdmin',
  'gridDiasMesAdmin',
  'labelMesAnoCalendarioAdmin',
  'btnMesAnteriorAgenda',
  'btnMesSeguinteAgenda',
  'btnMesHojeAgenda',
  'btnModoCalendarioAgenda',
  'btnModoListaAgenda',
  'painelDetalhesDiaSelecionado',
  'tabelaAgendamentosAdmin'
];

let allOk = true;
idsToCheck.forEach(id => {
  if (!html.includes(`id="${id}"`)) {
    console.error(`❌ Faltando elemento HTML com ID: ${id}`);
    allOk = false;
  }
});

const functionsToCheck = [
  'alternarModoVisualizacaoAgenda',
  'renderizarGradeMesAdmin',
  'selecionarDiaCalendarioAdmin',
  'carregarAgendamentosAdmin',
  'renderizarTabelaAgendamentos'
];

functionsToCheck.forEach(fn => {
  if (!html.includes(fn)) {
    console.error(`❌ Faltando função JavaScript: ${fn}`);
    allOk = false;
  }
});

if (allOk) {
  console.log('✅ SUCESSO: Todos os elementos e funções da Grade Mensal Interativa foram validados com 100% de conformidade!');
  process.exit(0);
} else {
  process.exit(1);
}
