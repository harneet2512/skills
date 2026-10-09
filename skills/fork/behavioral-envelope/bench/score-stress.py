import json,re,glob,os,subprocess,tempfile,shutil
import sys
keys=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'scenarios','answer-keys.json')))
os.chdir(sys.argv[1] if len(sys.argv)>1 else '.')
G=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','feature-loop','scripts','check-gates.sh')
def live_ids(p):
    t=open(p).read(); m=re.search(r'^## Live\s*\n(.*?)(?=^## )',t,re.S|re.M)
    ids=set()
    for line in (m.group(1) if m else '').splitlines():
        c=[x.strip() for x in line.strip().strip('|').split('|')]
        if c and re.match(r'^`?[A-Z]+-\d+`?$',c[0]): ids.add(c[0].strip('`'))
    return ids
def g2(p,size):
    d=tempfile.mkdtemp(); subprocess.run(['git','init','-q',d]); subprocess.run(['git','-C',d,'-c','user.email=t@t','-c','user.name=t','commit','-q','--allow-empty','-m','b'])
    os.makedirs(d+'/.scratch/envelope'); shutil.copy(p,d+'/.scratch/envelope/x.md')
    json.dump({'slug':'x','size':size,'base':'HEAD'},open(d+'/.scratch/gates.json','w'))
    r=subprocess.run(['bash',G,'G2'],cwd=d,capture_output=True,text=True); shutil.rmtree(d); return r.returncode==0, r.stdout.strip().splitlines()[0] if r.stdout else r.stderr
rows=[]
for s in sorted(keys):
    k=keys[s]; A=live_ids(f'{s}-A.md'); B=live_ids(f'{s}-B.md')
    rec=lambda X: sum(1 for i in k['live'] if i in X)/len(k['live'])
    mn=[i for i in k.get('must_not_live',[]) if i in A or i in B]
    iou=len(A&B)/len(A|B)
    size='small' if 'button' in s else 'normal'
    ga=g2(f'{s}-A.md',size); gb=g2(f'{s}-B.md',size)
    rows.append((s,rec(A),rec(B),iou,len(A),len(B),mn,ga[0],gb[0]))
    print(f"{s:22} recallA={rec(A):.0%} recallB={rec(B):.0%} agree={iou:.0%} live={len(A)}/{len(B)} mustnot={mn} G2={ga[0]}/{gb[0]}", '' if ga[0] and gb[0] else (ga[1],gb[1]))
print('mean recall', sum((r[1]+r[2])/2 for r in rows)/len(rows), 'mean agree', sum(r[3] for r in rows)/len(rows))
print('--- pack items only, and within packs both runs selected')
P={'CORE','VIS','UIB','API','DATA','OUT','IN','JOB','INT','LLM','RET','ID','FILE','PII','INF','DEP','MON'}
pk=lambda X:{i for i in X if i.split('-')[0] in P}
tot1=tot2=0
for s in sorted(keys):
    A=pk(live_ids(f'{s}-A.md')); B=pk(live_ids(f'{s}-B.md'))
    pa={i.split('-')[0] for i in A}; pb={i.split('-')[0] for i in B}; both=pa&pb
    A2={i for i in A if i.split('-')[0] in both}; B2={i for i in B if i.split('-')[0] in both}
    i1=len(A&B)/len(A|B); i2=len(A2&B2)/len(A2|B2); tot1+=i1; tot2+=i2
    print(f"{s:22} pack-items agree={i1:.0%}  same-packs agree={i2:.0%}  packs only in one run: {sorted((pa^pb))}")
print(f'mean pack-items {tot1/8:.0%}, mean same-packs {tot2/8:.0%}')
