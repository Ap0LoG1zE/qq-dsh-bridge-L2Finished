const fs=require('node:fs');
const files=[
  'state/social-v2.json',
  'state/social-v2.json.bak-newsession-20261110-161528',
  'state/social-v2.json.bak-newsession-20261108154809.',
];
for(const f of files){
  if(!fs.existsSync(f)){console.log(f+' 不存在');continue}
  const d=JSON.parse(fs.readFileSync(f,'utf8'));
  console.log('=== '+f+' ('+fs.statSync(f).size+' bytes)');
  for(const [k,v] of Object.entries(d.conversations||{})){
    const sn=Array.isArray(v.selfNotes)?v.selfNotes.length:0;
    const mi=Object.keys(v.memberImpressions||{}).length;
    const rm=Array.isArray(v.recentMessages)?v.recentMessages.length:0;
    console.log(`  ${k}: selfNote=${sn} 印象=${mi} 消息=${rm}`);
  }
  console.log();
}