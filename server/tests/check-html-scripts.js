import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';

const files = ['index.html', 'admin.html', 'redefinir-senha.html', 'termos.html'];
let total = 0;

for (const file of files) {
    const html = fs.readFileSync(path.resolve(file), 'utf8');
    const scripts = html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi);
    let index = 0;
    for (const match of scripts) {
        index++;
        const attributes = match[1] || '';
        const code = match[2] || '';
        if (/\bsrc\s*=/i.test(attributes) || !code.trim()) continue;
        const sourceType = /\btype\s*=\s*["']module["']/i.test(attributes) ? 'module' : 'script';
        try {
            parse(code, { ecmaVersion: 'latest', sourceType, allowHashBang: true });
            total++;
        } catch (error) {
            console.error(`${file} <script #${index}>: ${error.message}`);
            process.exitCode = 1;
        }
    }
}

if (!process.exitCode) console.log(`Sintaxe HTML/JS validada: ${total} bloco(s) inline.`);
