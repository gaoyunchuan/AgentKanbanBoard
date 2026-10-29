import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';

export type StudioOption = {value: string; label: string; disabled?: boolean};
type Props = {
  id?: string;
  label: string;
  value: string;
  options: readonly StudioOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  compact?: boolean;
  placeholder?: string;
};

export function StudioSelect({id,label,value,options,onValueChange,disabled,compact,placeholder='请选择'}:Props) {
  const choices=value&&!options.some(option=>option.value===value)?[...options,{value,label:value}]:options;
  const selected=choices.findIndex(option=>option.value===value);
  // Radix 不接受空字符串选项；内部索引避免默认空值或真实业务值与占位值碰撞。
  return <Select value={selected<0?'':`option:${selected}`} disabled={disabled} onValueChange={key=>{
    const option=choices[Number(key.slice(7))];
    if(option&&!option.disabled)onValueChange(option.value);
  }}>
    <SelectTrigger id={id} aria-label={label} className={`studio-select-trigger${compact?' compact':''}`}><SelectValue placeholder={placeholder}/></SelectTrigger>
    <SelectContent position="popper" sideOffset={6} align="start" collisionPadding={12} className="studio-overlay studio-select-content" data-studio-select-content="">
      {choices.map((option,index)=><SelectItem className="studio-select-item" key={option.value} value={`option:${index}`} disabled={option.disabled}><span className="studio-option-label" title={option.label}>{option.label}</span></SelectItem>)}
    </SelectContent>
  </Select>;
}
