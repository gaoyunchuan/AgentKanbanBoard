import { invoke } from "@tauri-apps/api/core";
import type { Workspace,ConversationDetail } from "./model";
export type StudioApi={native:boolean;call:<T=unknown>(method:string,params?:Record<string,unknown>)=>Promise<T>};
export const nativeApi:StudioApi={native:true,call:(method,params={})=>invoke("chat_command",{method,params})};
export const loadWorkspace=(api:StudioApi)=>api.call<Workspace>("snapshot");
export const loadConversation=(api:StudioApi,id:string)=>api.call<ConversationDetail>("detail",{conversation_id:id});
