// Stand-in for an official coding CLI (Codex, Claude Code). Tests run it as
// `node mock-coding-cli.js <mode> [args...]`; it never talks to a network.
import fs from 'node:fs';

const [mode, ...rest] = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => run());

function run() {
  switch (mode) {
    case 'version': console.log('mock-cli 9.9.9'); break;
    case 'ok': console.log('line one'); console.error('warning one'); console.log('line two'); break;
    case 'fail': console.error('it broke'); process.exit(3); break;
    case 'echo': console.log(JSON.stringify({ argv: rest, stdin, cwd: process.cwd() })); break;
    case 'env': console.log(JSON.stringify(process.env)); break;
    case 'secret': console.log('api_key=abcd1234efgh5678 and sk-abcdefghijklmnopqrstuv'); break;
    case 'write': fs.writeFileSync('created.txt', 'hi'); console.log('wrote'); break;
    case 'hang': {
      // A grandchild that would outlive its parent unless the group is killed.
      import('node:child_process').then(({ spawn }) => {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        console.log(`grandchild ${child.pid}`);
        setInterval(() => {}, 1000);
      });
      break;
    }
    default: console.error(`unknown mode ${mode}`); process.exit(2);
  }
}
