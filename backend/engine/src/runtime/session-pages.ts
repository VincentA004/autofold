import {Database} from 'bun:sqlite'
import {createHash} from 'node:crypto'
import {readSessionSnapshot} from './store'

const MAX_PAGE_BYTES=65_536
const digest=(bytes:string|Uint8Array)=>'sha256:'+createHash('sha256').update(bytes).digest('hex')
const valid=(offset:number,limit:number,max:number)=>Number.isSafeInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>0&&limit<=max
function head(db:Database,id:string){const row=db.query('SELECT state FROM pi_sessions WHERE id=?').get(id) as {state:string}|null;return row?JSON.parse(row.state):undefined}
function metadataColumns(db:Database){
  return new Set((db.query('PRAGMA table_info(pi_record_metadata)').all() as {name:string}[]).map(column=>column.name))
}
function pageRows(db:Database,id:string,start:number,end:number){
  const columns=metadataColumns(db),hasMetadata=columns.has('bytes'),hasRole=columns.has('role')
  const fields=hasMetadata ? `r.ordinal,COALESCE(m.bytes,length(CAST(r.value AS BLOB))) AS bytes,${hasRole?"COALESCE(m.role,'archive_fragment')":"'archive_fragment'"} AS role`
    : "r.ordinal,length(CAST(r.value AS BLOB)) AS bytes,'archive_fragment' AS role"
  const join=hasMetadata?"LEFT JOIN pi_record_metadata m ON m.session_id=r.session_id AND m.kind=r.kind AND m.ordinal=r.ordinal":""
  return db.query(`SELECT ${fields} FROM pi_records r ${join} WHERE r.session_id=? AND r.kind='message' AND r.ordinal>=? AND r.ordinal<? ORDER BY r.ordinal`).all(id,start,end) as {ordinal:number;bytes:number;role:string}[]
}
function record(db:Database,id:string,index:number){return pageRows(db,id,index,index+1)[0]}
function bytes(db:Database,id:string,index:number,offset:number,limit:number):Uint8Array|undefined{
  const columns=metadataColumns(db)
  if(columns.has('fragment_count')){
    const metadata=db.query("SELECT bytes,fragment_count FROM pi_record_metadata WHERE session_id=? AND kind='message' AND ordinal=?").get(id,index) as {bytes:number;fragment_count:number}|null
    if(metadata?.fragment_count){
      if(metadata.fragment_count!==Math.ceil(metadata.bytes/MAX_PAGE_BYTES))throw new Error('Original Pi fragment archive is incomplete')
      const start=Math.floor(offset/MAX_PAGE_BYTES),end=Math.min(metadata.fragment_count,Math.ceil(Math.min(metadata.bytes,offset+limit)/MAX_PAGE_BYTES))
      const rows=db.query("SELECT fragment,bytes,digest FROM pi_record_fragments WHERE session_id=? AND kind='message' AND ordinal=? AND fragment>=? AND fragment<? ORDER BY fragment").all(id,index,start,end) as {fragment:number;bytes:Uint8Array;digest:string}[]
      if(rows.length!==Math.max(0,end-start)||rows.some((row,i)=>row.fragment!==start+i||row.bytes.length!==Math.min(MAX_PAGE_BYTES,metadata.bytes-row.fragment*MAX_PAGE_BYTES)||digest(row.bytes)!==row.digest))throw new Error('Original Pi fragment archive is incomplete or corrupt')
      const joined=Buffer.concat(rows.map(row=>Buffer.from(row.bytes)))
      return joined.subarray(offset-start*MAX_PAGE_BYTES,offset-start*MAX_PAGE_BYTES+limit)
    }
  }
  // Original archives without fresh fragment metadata retain a readonly fallback.
  return (db.query("SELECT substr(CAST(value AS BLOB),?,?) AS bytes FROM pi_records WHERE session_id=? AND kind='message' AND ordinal=?").get(offset+1,limit,id,index) as {bytes:Uint8Array}|null)?.bytes
}
function recordHash(db:Database,id:string,index:number,total:number){
  const metadata=db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pi_record_metadata'").get()
  if(metadata){const row=db.query("SELECT digest,bytes FROM pi_record_metadata WHERE session_id=? AND kind='message' AND ordinal=?").get(id,index) as {digest:string;bytes:number}|null;if(row&&row.bytes===total)return row.digest}
  // Existing append archives are never migrated by observation. Hash in fixed byte
  // windows when no fresh metadata exists; this fallback is bounded in memory.
  const hash=createHash('sha256')
  for(let offset=0;offset<total;offset+=MAX_PAGE_BYTES){const chunk=bytes(db,id,index,offset,MAX_PAGE_BYTES);if(!chunk||chunk.length!==Math.min(MAX_PAGE_BYTES,total-offset))throw new Error('Original Pi archive is incomplete');hash.update(chunk)}
  return 'sha256:'+hash.digest('hex')
}
function legacyPage(saved:any,offset:number,limit:number,anchor?:string){
  const reset=offset>saved.messages.length||offset>0&&anchor!==digest(JSON.stringify(saved.messages[offset-1]))
  const start=reset?0:offset,end=Math.min(saved.messages.length,start+limit)
  const {sdk,messages,pendingTools,modelRequests,contextCompactions,...metadata}=saved
  let consumed=0
  const page=messages.slice(start,end).map((message:unknown,index:number)=>{const serialized=JSON.stringify(message),total=Buffer.byteLength(serialized);if(total+consumed<=MAX_PAGE_BYTES){consumed+=total;return message}return {role:(message as any)?.role,content:'[Large original message; retrieve byte pages]',transcriptFragment:{index:start+index,messageHash:digest(serialized),totalBytes:total,nextOffsetBytes:0}}})
  return {session:metadata,messages:page,offset:start,nextOffset:end,anchor:end?digest(JSON.stringify(messages[end-1])):undefined,totalMessages:messages.length,hasMore:end<messages.length,reset}
}

/** Derivative observation only. Fresh messages seek the original composite index;
 * SDK entries and unrelated transcript bytes are never reconstructed for a page. */
export function readSessionTranscriptPage(db:Database,id:string,offset=0,limit=100,anchor?:string){
  if(!valid(offset,limit,100))throw new Error('Invalid transcript cursor')
  return db.transaction(()=>{
    const saved=head(db,id);if(!saved)return undefined
    if(!saved.storageFormat)return legacyPage(readSessionSnapshot(db,id),offset,limit,anchor)
    if(saved.storageFormat!=='autofold.pi-store.v2')throw new Error('Unsupported original Pi storage format')
    const total=saved.archiveCounts?.message
    if(!Number.isSafeInteger(total)||total<0)throw new Error('Original Pi archive is incomplete')
    const previous=offset>0&&offset<=total?record(db,id,offset-1):undefined
    if(offset>0&&offset<=total&&!previous)throw new Error('Original Pi archive is incomplete')
    const reset=offset>total||offset>0&&anchor!==recordHash(db,id,offset-1,previous!.bytes)
    const start=reset?0:offset,end=Math.min(total,start+limit)
    const rows=pageRows(db,id,start,end)
    if(rows.length!==end-start||rows.some((row,index)=>row.ordinal!==start+index))throw new Error('Original Pi archive is incomplete')
    let consumed=0
    const messages=rows.map(row=>{
      if(row.bytes+consumed<=MAX_PAGE_BYTES){const value=bytes(db,id,row.ordinal,0,row.bytes);if(!value||value.length!==row.bytes)throw new Error('Original Pi archive is incomplete');consumed+=row.bytes;return JSON.parse(Buffer.from(value).toString('utf8'))}
      return {role:row.role,content:'[Large original message; retrieve byte pages]',transcriptFragment:{index:row.ordinal,messageHash:recordHash(db,id,row.ordinal,row.bytes),totalBytes:row.bytes,nextOffsetBytes:0}}
    })
    const {sdk,messages:unused,pendingTools,modelRequests,contextCompactions,storageFormat,archiveCounts,...metadata}=saved
    const last=rows.at(-1)
    return {session:metadata,messages,offset:start,nextOffset:end,anchor:last?recordHash(db,id,last.ordinal,last.bytes):start?recordHash(db,id,start-1,previous!.bytes):undefined,totalMessages:total,hasMore:end<total,reset}
  }).deferred()
}

/** Exact serialized original-message JSON in UTF-8 windows, bound to original
 * bytes by hash. Giant legacy JSON still needs its retained legacy decoder. */
export function readSessionMessageContent(db:Database,id:string,index:number,offsetBytes=0,limitBytes=MAX_PAGE_BYTES,expectedHash?:string){
  if(!Number.isSafeInteger(index)||index<0||!valid(offsetBytes,limitBytes,MAX_PAGE_BYTES))throw new Error('Invalid message byte cursor')
  return db.transaction(()=>{
    const saved=head(db,id);if(!saved)return undefined
    let totalBytes:number,messageHash:string,chunk:Uint8Array|undefined
    if(!saved.storageFormat){const message=readSessionSnapshot(db,id)?.messages[index];if(message===undefined)return undefined;const raw=Buffer.from(JSON.stringify(message));totalBytes=raw.length;messageHash=digest(raw);chunk=raw.subarray(offsetBytes,offsetBytes+limitBytes+4)}
    else {
      if(saved.storageFormat!=='autofold.pi-store.v2')throw new Error('Unsupported original Pi storage format')
      const count=saved.archiveCounts?.message
      if(!Number.isSafeInteger(count)||count<0)throw new Error('Original Pi archive is incomplete')
      if(index>=count)return undefined
      const row=record(db,id,index);if(!row)throw new Error('Original Pi archive is incomplete')
      totalBytes=row.bytes;messageHash=recordHash(db,id,index,totalBytes);chunk=bytes(db,id,index,offsetBytes,limitBytes+4)
    }
    if(expectedHash&&expectedHash!==messageHash)throw new Error('Original message byte identity changed')
    if(offsetBytes>totalBytes)throw new Error('Message byte cursor exceeds original content')
    if(chunk?.length&&chunk[0]!>=0x80&&chunk[0]!<0xc0)throw new Error('Message byte cursor splits a UTF-8 code point')
    let length=Math.min(limitBytes,chunk?.length??0)
    while(length>0&&length<(chunk?.length??0)&&chunk![length]!>=0x80&&chunk![length]!<0xc0)length--
    if(!length&&offsetBytes<totalBytes)throw new Error('Message byte limit cannot contain the next UTF-8 code point')
    const text=Buffer.from(chunk?.subarray(0,length)??[]).toString('utf8'),nextOffsetBytes=offsetBytes+length
    return {text,offsetBytes,nextOffsetBytes,totalBytes,hasMore:nextOffsetBytes<totalBytes,messageHash,encoding:'original_message_json_utf8' as const}
  }).deferred()
}

export function readSessionEventPage(db:Database,id:string,afterSequence=-1,limit=100){
  if(!Number.isSafeInteger(afterSequence)||afterSequence< -1||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid event cursor')
  return db.transaction(()=>{if(!head(db,id))return undefined;const rows=db.query('SELECT sequence,event FROM pi_journal WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id,afterSequence,limit+1) as {sequence:number;event:string}[];const page=rows.slice(0,limit);return {events:page.map(row=>JSON.parse(row.event)),nextSequence:page.at(-1)?.sequence??afterSequence,hasMore:rows.length>limit}}).deferred()
}
