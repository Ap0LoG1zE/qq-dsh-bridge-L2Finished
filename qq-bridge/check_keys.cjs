const fs=require('node:fs');
const d=JSON.parse(fs.readFileSync('state/social-v2.json','utf8'));
for(const [k,v] of Object.entries(d.conversations)){
  const sn = Array.isArray(v.selfNotes)?v.selfNotes.length:0;
  const mi = Object.keys(v.memberImpressions||{}).length;
  console.log(`${k}  selfNote=${sn}  印象=${mi}`);
}