import {NextResponse} from 'next/server';
import {resolveSessionPath} from '@/lib/session-reader';
import {getRemoteSession} from '@/lib/remote-sessions';
import {getVisualFrames} from '@/lib/visual-frame';
export const runtime='nodejs';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const {id}=await params;
 let exists=false;
 try {exists=Boolean(getRemoteSession(id));}catch{}
 if(!exists)exists=Boolean(await resolveSessionPath(id));
 if(!exists)return NextResponse.json({error:'Unknown thread'},{status:404});
 try{return NextResponse.json(await getVisualFrames(id))}catch{return NextResponse.json({error:'Unable to read visuals'},{status:500})}
}
