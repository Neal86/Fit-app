import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeAccountChannel, type NativeAccountAndroidChannel } from './nativeAccountChannel'
import { readNativeAccountRequest } from './nativeAccountContract'
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-a192-42bf-8c12-b75575810302`
const ctx = { version: 1 as const, contextId: id(1) }
const request = (n: number) => ({ ...ctx, requestId: id(n), method: 'GET' as const, path: 'sync' })
function fixture() {
  const calls: { callId: string; operation: string; payload: Record<string, unknown> }[] = []
  let serial=100
  vi.stubGlobal('crypto', { randomUUID: () => id(serial++) })
  const endpoint: NativeAccountAndroidChannel = { postMessage: s => { calls.push(JSON.parse(s)) } }
  const channel = createNativeAccountChannel({ target: { FitflowNativeAccounts: endpoint } })
  const send=(n:number,value:unknown) => endpoint.onmessage?.({ data: JSON.stringify({ version:1, callId:calls[n].callId, ok:true,value }) })
  return { calls, endpoint, channel, send }
}
afterEach(() => { vi.useRealTimers();vi.unstubAllGlobals() })
describe('independent native adapter boundary checks', () => {
 it('does not let a valid response for a completed call consume a distinct pending request', async () => {
  const h=fixture();const start=h.channel.startContext(ctx);h.send(0,ctx);await start
  const a=h.channel.request(request(2));const b=h.channel.request(request(3))
  const first={ ...ctx,requestId:id(2),status:200,body:{value:'first'} }
  h.send(1,first);expect((await a).body).toEqual({value:'first'})
  h.send(1,{...first,body:{value:'replayed private data'}})
  h.send(2,{...ctx,requestId:id(3),status:200,body:{value:'second'}})
  expect((await b).body).toEqual({value:'second'});h.channel.dispose()
 })
 it('rejects a reply with escaped duplicate version fields without completing a pending call', async () => {
  vi.useFakeTimers();const h=fixture();const p=h.channel.capabilities({version:1});const result=p.catch(e=>e)
  h.endpoint.onmessage?.({data:`{"version":1,"\\u0076ersion":1,"callId":"${h.calls[0].callId}","ok":true,"value":{"version":1,"available":true}}`})
  await vi.advanceTimersByTimeAsync(20000);expect(await result).toMatchObject({code:'expired'});h.channel.dispose()
 })
 it('accepts exact contract depth through one extra wire envelope', async () => {
  const h=fixture();const start=h.channel.startContext(ctx);h.send(0,ctx);await start
  let nested: unknown=0;for(let i=0;i<30;i++)nested={value:nested}
  const command=readNativeAccountRequest({...ctx,requestId:id(4),method:'PUT',path:'sync',body:{value:nested}})
  const p=h.channel.request(command);expect(h.calls[1].payload).toEqual(command)
  h.send(1,{...ctx,requestId:id(4),status:200,body:{value:nested}});expect((await p).status).toBe(200);h.channel.dispose()
 })
 it('a malformed old callback never clears a newer native context', async () => {
  const h=fixture();const old=h.channel.startContext(ctx);const result=old.catch(e=>e)
  const newer={...ctx,contextId:id(9)};const current=h.channel.startContext(newer)
  const currentIndex=h.calls.findIndex(c=>c.operation==='startContext'&&c.payload.contextId===newer.contextId)
  h.send(currentIndex,newer);await current;expect(await result).toMatchObject({code:'cancelled'})
  h.endpoint.onmessage?.({data:`{"version":1,"callId":"${h.calls[0].callId}","ok":true,"value":{"version":1}}`})
  const p=h.channel.request({...request(5),contextId:newer.contextId});const n=h.calls.length-1
  h.send(n,{...newer,requestId:id(5),status:200,body:{value:'new account'}})
  expect((await p).body).toEqual({value:'new account'});h.channel.dispose()
 })
})

for (const kind of ['android', 'ios'] as const) it(`independent ${kind} failed replacement leaves no old native context`, async () => {
  let serial=100;vi.stubGlobal('crypto',{randomUUID:()=>id(serial++)})
  let nativeContext: string | undefined
  const next={...ctx,contextId:id(8)}
  const process=(wire: string) => {
    const c=JSON.parse(wire) as { callId:string; operation:string; payload: { contextId:string } }
    if(c.operation==='startContext') {
      if(c.payload.contextId===next.contextId) throw new Error('synthetic failed dispatch')
      nativeContext=c.payload.contextId
    } else if(c.operation==='clearContext' && nativeContext===c.payload.contextId) nativeContext=undefined
    return JSON.stringify({version:1,callId:c.callId,ok:true,value:c.payload})
  }
  const endpoint: NativeAccountAndroidChannel={postMessage:wire=>endpoint.onmessage?.({data:process(wire)})}
  const target=kind==='android'?{FitflowNativeAccounts:endpoint}:{webkit:{messageHandlers:{FitflowNativeAccounts:{postMessage:(wire:string)=>Promise.resolve().then(()=>process(wire))}}}}
  const channel=createNativeAccountChannel({target})
  await channel.startContext(ctx);expect(nativeContext).toBe(ctx.contextId)
  await expect(channel.startContext(next)).rejects.toMatchObject({code:'unavailable'})
  expect(nativeContext).toBeUndefined();channel.dispose()
})
