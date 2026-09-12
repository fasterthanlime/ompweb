import {NextResponse} from 'next/server';
import {listAllSessions} from '@/lib/session-reader';
import {listRemoteSessions} from '@/lib/remote-sessions';
import {getThreadExpression} from '@/lib/thread-expression';
export async function GET(){
 const local=await listAllSessions();const remote=listRemoteSessions().sessions;
 return NextResponse.json(Object.fromEntries([...local,...remote].map(thread=>{const {expression,caption}=getThreadExpression(thread.id);return [thread.id,{expression,caption}]})));
}
