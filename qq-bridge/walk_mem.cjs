const fs=require('node:fs');
console.log('=== state/memory 结构 ===');
function walk(d, depth){
  if(depth>2)return;
  try{
    for(const f of fs.readdirSync(d)){
      const p=d+'/'+f;
      const s=fs.statSync(p);
      if(s.isDirectory()){ console.log('  '.repeat(depth)+'[dir] '+f); walk(p,depth+1) }
      else console.log('  '.repeat(depth)+f+'  '+s.size+' bytes');
    }
  }catch(e){console.log('  读取失败: '+e.message)}
}
walk('state/memory',0);