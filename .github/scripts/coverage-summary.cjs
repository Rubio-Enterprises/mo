const fs = require('node:fs');
const { summary } = require('./coverage-report.cjs');

const raw = JSON.parse(fs.readFileSync('reports/coverage/metrics.json', 'utf8'));
const numbers = { covered: raw.coverage?.covered, total: raw.coverage?.total, code: raw.code_to_test_ratio?.code, test: raw.code_to_test_ratio?.test };
fs.writeFileSync('reports/coverage/summary.json', JSON.stringify(summary(numbers)) + '\n');
