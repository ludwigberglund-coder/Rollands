'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {validateContent} = require('./validate-content.js');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'dist');

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Källkatalog saknas: ${path.relative(root, source)}`);
  fs.mkdirSync(destination, {recursive: true});
  fs.cpSync(source, destination, {recursive: true});
}
function copyFile(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Källfil saknas: ${path.relative(root, source)}`);
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  fs.copyFileSync(source, destination);
}
function buildStatic() {
  const report = validateContent();
  if (!report.ok) throw new Error(`Innehållet är ogiltigt: ${report.errors[0]}`);
  fs.rmSync(target, {recursive: true, force: true});
  fs.mkdirSync(target, {recursive: true});
  copyDirectory(path.join(root, 'apps', 'website'), target);
  copyDirectory(path.join(root, 'apps', 'admin'), path.join(target, 'admin'));
  copyDirectory(path.join(root, 'apps', 'portal'), path.join(target, 'portal'));
  copyDirectory(path.join(root, 'packages', 'shared', 'browser'), path.join(target, 'shared'));
  copyFile(path.join(root, 'packages', 'accounting', 'money.js'), path.join(target, 'shared', 'accounting', 'money.js'));
  copyFile(path.join(root, 'packages', 'accounting', 'journal.js'), path.join(target, 'shared', 'accounting', 'journal.js'));
  copyFile(path.join(root, 'packages', 'access-control', 'authorization.js'), path.join(target, 'shared', 'access-control', 'authorization.js'));
  copyFile(path.join(root, 'packages', 'receivables', 'customer-receivables.js'), path.join(target, 'shared', 'receivables', 'customer-receivables.js'));
  copyDirectory(path.join(root, 'content'), path.join(target, 'content'));
  copyDirectory(path.join(root, 'config'), path.join(target, 'config'));
  copyDirectory(path.join(root, 'public'), path.join(target, 'legacy'));
  copyFile(path.join(root, 'apps', 'website', 'index.html'), path.join(target, '404.html'));
  fs.writeFileSync(path.join(target, '.nojekyll'), '');
  fs.writeFileSync(path.join(target, 'build-info.json'), `${JSON.stringify({source:'GitHub main',commit:process.env.GITHUB_SHA || 'local',generatedAt:new Date().toISOString(),demoOnly:true}, null, 2)}\n`);
  const required = [
    'index.html', 'app.js', 'styles.css',
    'admin/index.html', 'admin/app.js', 'admin/money-view.js', 'admin/money.css',
    'admin/access-view.js', 'admin/access.css', 'admin/journal-view.js', 'admin/journal.css',
    'portal/index.html', 'portal/app.js', 'portal/styles.css', 'portal/automation-link.js',
    'portal/automation.html', 'portal/automation.js', 'portal/automation.css',
    'portal/bank.html', 'portal/bank.js', 'portal/bank.css',
    'portal/payables.html', 'portal/payables.js', 'portal/payables.css', 'portal/payables-queue.js', 'portal/payables-registration-ui.js',
    'shared/content.js', 'shared/accounting/money.js', 'shared/accounting/journal.js',
    'shared/access-control/authorization.js', 'shared/receivables/customer-receivables.js',
    'content/company.json', 'content/site.json', 'content/admin.json',
    'config/rolands-business-decisions.json', 'config/access-control.json', 'config/legal-rates.json', 'legacy/index.html'
  ];
  for (const relativePath of required) if (!fs.existsSync(path.join(target, relativePath))) throw new Error(`Byggfil saknas: ${relativePath}`);
  console.log(`Ny statisk demo byggd: ${target}`);
  return target;
}
if (require.main === module) {
  try { buildStatic(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {buildStatic};
