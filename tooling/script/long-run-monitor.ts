import {parseArgs} from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import {longRunSnapshot} from '../../backend/engine/src/monitor'

const {values} = parseArgs({options:{workspace:{type:'string'},project:{type:'string'},campaign:{type:'string'},output:{type:'string'},help:{type:'boolean'}},strict:true,allowPositionals:false})
if(values.help) {
  console.log('bun tooling/script/long-run-monitor.ts --workspace ABSOLUTE_PATH --project ID [--campaign cmp_ID] [--output FILE]\nOne offline, read-only snapshot. Output defaults to stdout.')
} else {
  if(!values.workspace || !values.project) throw new Error('--workspace and --project are required')
  const snapshot = await longRunSnapshot({workspace:values.workspace,project:values.project,campaign:values.campaign})
  const text = JSON.stringify(snapshot,null,2)+'\n'
  if(values.output) {
    // Exclusive creation prevents accidental overwrite of any source or prior report.
    await fs.writeFile(path.resolve(values.output),text,{flag:'wx',mode:0o600})
  } else process.stdout.write(text)
}
