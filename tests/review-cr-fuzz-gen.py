# Generates (shared, live) pairs; checks merged output against tomllib. Usage: gen OUT N SEED / check OUT RESULT
import json, random, sys, tomllib
VALS = ['1','true','"s"','"a # b"','"[x]"',"'lit # [y]'",'"q\\"uote"','1979-05-27T07:32:00Z','[1, 2]','["]", "["]',
 '[\n  1, # it\'s "c" ]\n  2,\n]','[[1,2],\n [3]]','{ x = 1, y = "}" }','"""\nml [t]\n# not comment\n"""',"'''\n[projects.\"/z\"]\nk = 1\n'''",
 '"""a""""','"""""a"""','""','\'\'','"""x\\\n   y"""','[\n  { a = 1 },\n  { b = "]" }, # c\n]']
ROOTK = ['model','a','b.c','"q k"',"'l.k'",'x-y','n1.n2.n3','"dot.ted".z']
LOCALROOT = ['projects."/a".trust_level','"projects"."/b".trust_level',"'projects'.'/c'.trust_level",'"\\u0070rojects"."/d".trust_level','projects."/e [x]".t']
TAB = ['[t1]','[ t2 . sub ]','[t3] # c','["t4"."x.y"]','[[arr]]','[[arr.kid]]','[t5.projects]',"['t6']",'[z."projects"]']
LOCALTAB = ['[projects."/w"]','[projects."/w x"]','["projects"."/v"]',"['projects'.'/u']",'[projects."/s".inner]','[ projects . "/r" ]','[projects."/#h"] # c','["\\u0070rojects"."/p"]']
def body(r, keys):
    out=[]
    for k in r.sample(['k1','k2','"k 3"','d.e','k4'], r.randint(0,3)):
        if r.random()<.2: out.append('# c "unbalanced')
        out.append(f'{k} = {r.choice(VALS)}')
    if r.random()<.2: out.append('')
    return out
def doc(r, localweight):
    L=[]
    if r.random()<.3: L.append('# top "comment')
    used=set()
    for k in r.sample(ROOTK, r.randint(0,4)):
        if r.random()<.2: L.append('')
        L.append(f'{k} = {r.choice(VALS)}')
    if r.random()<localweight:
        for k in r.sample(LOCALROOT, r.randint(1,2)):
            L.append(f'{k} = {r.choice(VALS)}')
    tabs=r.sample(TAB, r.randint(0,4))
    if r.random()<localweight: tabs+=r.sample(LOCALTAB, r.randint(1,3))
    r.shuffle(tabs)
    for t in tabs:
        if r.random()<.5: L.append('')
        if r.random()<.3: L.append('# about "this\' [table]')
        L.append(t); L+=body(r,None)
    s='\n'.join(L)
    if r.random()<.9: s+='\n'
    if r.random()<.15: s=s.replace('\n','\r\n')
    if r.random()<.1: s='\ufeff'+s
    return s
def valid(s):
    try: tomllib.loads(s.lstrip('\ufeff')); return True
    except Exception: return False
if sys.argv[1]=='gen':
    r=random.Random(int(sys.argv[4])); cases=[]
    while len(cases)<int(sys.argv[3]):
        a,b=doc(r,.3),doc(r,.8)
        if r.random()<.1: a=b # shared IS live
        if valid(a) and valid(b): cases.append({'shared':a,'live':b})
    json.dump(cases,open(sys.argv[2],'w'))
else:
    cases=json.load(open(sys.argv[2])); res=json.load(open(sys.argv[3]))
    bad=ref=ok=0; reasons={}
    for c,m in zip(cases,res):
        s=tomllib.loads(c['shared'].lstrip('\ufeff')); l=tomllib.loads(c['live'].lstrip('\ufeff'))
        exp={k:v for k,v in s.items() if k!='projects'}
        if 'projects' in l: exp['projects']=l['projects']
        if m.get('err'):
            ref+=1; reasons[m['err'][:60]]=reasons.get(m['err'][:60],0)+1; continue
        try:
            got=tomllib.loads(m['text'])
        except Exception as e:
            bad+=1
            if bad<4: print('UNPARSEABLE',e,repr(c),repr(m['text']))
            continue
        if got!=exp:
            bad+=1
            if bad<4: print('MISMATCH',repr(c),'\nGOT',got,'\nEXP',exp)
        else: ok+=1
    print('ok',ok,'refused',ref,'bad',bad); print(reasons)
