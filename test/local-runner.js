/**
 * Test runner that compiles and runs TypeScript tests
 */

const { spawn } = require('child_process')
const path = require('path')

console.log('Compiling and running local tests...\n')

const tsNode = spawn('npx', ['tsx', path.join(__dirname, 'local-test.ts')], {
  stdio: 'inherit',
  env: process.env,
})

tsNode.on('close', (code) => {
  process.exit(code)
})
