const fs=require('node:fs');
// 看 memory 目录里有没有 selfNotes 的独立存档
const dirs=['state/memory'];
for(const d of dirs){
  if(!fs.existsSync(d))continue;
  console.log('=== '+d+' ===');
  for(const f of fs.readdirSync(d)){
    const p=d+'/'+f;
    const stat=fs.statSync(p);
    console.log(`  ${f}  ${stat.size} bytes  ${stat.mtime.toISOString()}`);
  }
}