import { PanelLeft, Plus } from 'lucide-react';
import { useStudio } from './context';
import { ConversationHeader } from './ChatSurface';
import './workspace-header.css';

export function WorkspaceHeader({conversationVisible,sidebarVisible,onToggleSidebar,onToolHost}:{conversationVisible:boolean;sidebarVisible:boolean;onToggleSidebar:()=>void;onToolHost:(element:HTMLDivElement|null)=>void}) {
  const s=useStudio();
  const platform=typeof window==='undefined'?'web':(window as any).akb?.platform||'web';
  const title={chat:'新会话',tasks:'任务',projects:'项目',attention:'需要你',settings:'设置'}[s.view];
  return <header className={`workspace-header platform-${platform}`} aria-label="工作区标题栏" data-tauri-drag-region>
    <div className="header-navigation"><button className="iconbtn" aria-label="切换侧栏" aria-expanded={sidebarVisible} onClick={onToggleSidebar}><PanelLeft size={17}/></button></div>
    <div className="workspace-center-header" role="toolbar" aria-label="会话与任务操作">
    {conversationVisible?<ConversationHeader/>:<>
      <div className="head-title"><h1>{title}</h1></div>
      <div className="header-actions">{s.view==='tasks'&&<><button className="textbtn" onClick={()=>s.openDialog({kind:'deleted'})}>已删除</button><button className="textbtn primary" onClick={()=>s.openDialog({kind:'createTask'})}><Plus size={15}/>新建任务</button></>}
        {s.view==='projects'&&<button className="textbtn primary" onClick={()=>s.openDialog({kind:'project'})}><Plus size={15}/>添加本地项目</button>}
      </div>
    </>}
    </div>
    <div className="workspace-tools-host" ref={onToolHost}/>
  </header>;
}
