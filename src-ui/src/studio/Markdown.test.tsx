import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
import {Markdown} from './components';
const diagram=vi.hoisted(()=>({initialize:vi.fn(),render:vi.fn(async()=>({svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text>流程</text></svg>'}))}));
vi.mock('mermaid',()=>({default:diagram}));
it('渲染本地路径和包含括号的网页Markdown链接，点击交给工作区',async()=>{
 const open=vi.fn(),user=userEvent.setup();render(<Markdown text={'[提案](/Users/me/project/a.md) 与 [文档](https://example.com/docs_(v2))'} onOpenLink={open}/>);
 await user.click(screen.getByRole('link',{name:'提案'}));expect(open).toHaveBeenCalledWith('/Users/me/project/a.md');
 expect(screen.getByRole('link',{name:'文档'})).toHaveAttribute('href','https://example.com/docs_(v2)');
});
it('Mermaid显示为图，普通代码仍显示代码；危险链接和HTML不执行',async()=>{
 render(<Markdown text={'```mermaid\nflowchart LR\n A --> B\n```\n```ts\nconst x = 1\n```\n[危险](javascript:alert%281%29)\n<script>alert(1)</script>'}/>);
 expect(await screen.findByRole('img',{name:'Mermaid 流程图'})).toHaveAttribute('src',expect.stringContaining('data:image/svg+xml'));
 expect(screen.getByText('const x = 1')).toBeVisible();expect(screen.queryByRole('link',{name:'危险'})).not.toBeInTheDocument();expect(document.querySelector('script')).toBeNull();
 await waitFor(()=>expect(diagram.initialize).toHaveBeenCalledWith(expect.objectContaining({securityLevel:'strict'})));
});
it('普通仓库相对路径也渲染为可点击文件链接',async()=>{
 const user=userEvent.setup(),open=vi.fn();render(<Markdown text={'[说明](README.md) 与 [实现](src/foo.ts)'} onOpenLink={open}/>);
 await user.click(screen.getByRole('link',{name:'说明'}));expect(open).toHaveBeenCalledWith('README.md');
 expect(screen.getByRole('link',{name:'实现'})).toHaveAttribute('href','src/foo.ts');
});

it('流程图离开视口释放图片时保留占位比例，避免滚动跳动',async()=>{
 let update:((entries:{isIntersecting:boolean}[])=>void)|undefined;
 vi.stubGlobal('IntersectionObserver',class {constructor(callback:typeof update){update=callback}observe(){}disconnect(){}});
 render(<Markdown text={'```mermaid\ngraph TB\n A --> C\n```'}/>);
 act(()=>update?.([{isIntersecting:true}]));await screen.findByRole('img',{name:'Mermaid 流程图'});
 act(()=>update?.([{isIntersecting:false}]));
 await waitFor(()=>expect(document.querySelector('.mermaid-status')).toHaveStyle({aspectRatio:'2'}));
});
