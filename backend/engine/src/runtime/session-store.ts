import {Database} from 'bun:sqlite'
import {existsSync} from 'node:fs'
import {SqliteSessionStore,readSessionSnapshot} from './store'
import type {PiRuntimeEvent} from './types'
import {AppendOnlySessionStore} from './append-store'
import {readSessionTranscriptPage,readSessionMessageContent,readSessionEventPage} from './session-pages'
/** Fresh projects opt into append storage; existing legacy projects stay on their
 * original reader/writer. Selection does not initialize or migrate old data. */
export function createSessionStore(path:string) {
  if(path===':memory:' || !existsSync(path))return new AppendOnlySessionStore(path)
  const db=new Database(path,{readonly:true})
  let append=false
  try {append=!!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pi_records'").get()}
  finally{db.close()}
  return append?new AppendOnlySessionStore(path):new SqliteSessionStore(path)
}

/** Existing-session observation only. No schema creation, migration, WAL mode
 * change, lease acquisition, initialization, or writable store constructor. */
export function openSessionReader(file:string) {
  if(file===':memory:'||!existsSync(file))return undefined
  const db=new Database(file,{readonly:true})
  return {
    get:async(id:string)=>readSessionSnapshot(db,id),
    messages:async(id:string,offset=0,limit=100,anchor?:string)=>readSessionTranscriptPage(db,id,offset,limit,anchor),
    messageContent:async(id:string,index:number,offsetBytes=0,limitBytes=65_536,expectedHash?:string)=>readSessionMessageContent(db,id,index,offsetBytes,limitBytes,expectedHash),
    eventPage:async(id:string,afterSequence=-1,limit=100)=>readSessionEventPage(db,id,afterSequence,limit),
    events:async(id:string)=>(db.query('SELECT event FROM pi_journal WHERE session_id=? ORDER BY sequence').all(id) as {event:string}[]).map(row=>JSON.parse(row.event) as PiRuntimeEvent),
    close:()=>db.close(),
  }
}
