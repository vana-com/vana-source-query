/**
 * Local Test Script
 * Tests core library functions without hitting external APIs
 */

import { packLocalRepo, assemblePackedContext } from '../lib/repomix'
import { PackedRepo } from '../lib/types'
import path from 'path'

async function testLocalPacking() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧪 Testing Local Repomix Packing')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const fixturePath = path.join(__dirname, 'fixtures', 'sample-repo')

  console.log(`📁 Fixture path: ${fixturePath}\n`)

  try {
    // Test 1: Basic packing
    console.log('Test 1: Basic packing (all files)')
    const result1 = await packLocalRepo({
      directory: fixturePath,
    })

    if (result1.error) {
      console.error('❌ Failed:', result1.error)
    } else {
      console.log('✅ Success!')
      console.log(`   Files: ${result1.stats.fileCount}`)
      console.log(`   Chars: ${result1.stats.approxChars}`)
      console.log(`   Tokens (approx): ${result1.stats.approxTokens}\n`)
    }

    // Test 2: With include filter
    console.log('Test 2: Include filter (*.ts only)')
    const result2 = await packLocalRepo({
      directory: fixturePath,
      includeGlobs: ['**/*.ts'],
    })

    if (result2.error) {
      console.error('❌ Failed:', result2.error)
    } else {
      console.log('✅ Success!')
      console.log(`   Files: ${result2.stats.fileCount}`)
      console.log(`   Chars: ${result2.stats.approxChars}`)
      console.log(`   Tokens (approx): ${result2.stats.approxTokens}\n`)
    }

    // Test 3: Assemble multiple repos (without prompt)
    console.log('Test 3: Assemble context (without prompt)')
    const assembled = assemblePackedContext([result1, result2])

    console.log('✅ Assembled context')
    console.log(`   Total chars: ${assembled.length}`)
    console.log(`   Preview:\n`)
    console.log(assembled.slice(0, 500))
    console.log('\n   ... (truncated)\n')

    // Test 4: Assemble with user prompt
    console.log('Test 4: Assemble context (with user prompt)')
    const assembledWithPrompt = assemblePackedContext(
      [result1, result2],
      'Explain the main functionality of this codebase'
    )

    console.log('✅ Assembled with prompt')
    console.log(`   Total chars: ${assembledWithPrompt.length}`)
    console.log(`   Prompt is prepended: ${assembledWithPrompt.startsWith('# User Prompt') ? 'Yes ✓' : 'No ✗'}`)

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('✅ All tests passed!')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  } catch (error) {
    console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.error('❌ Test failed:')
    console.error(error)
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    process.exit(1)
  }
}

testLocalPacking()
