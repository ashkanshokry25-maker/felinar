import subprocess, sys, json, re, time
H='b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553'
CID='QmRA3NWM82ZGynMbYzAgYTSXCVM14Wx1RZ8fKP42G6gjgj'
TARGETS=[
 ('GitHub Pages png','https://pages.github.com/images/slideshow/bootstrap.png'),
 ('GitHub Pages css','https://pages.github.com/css/pages.css'),
 ('Netlify woff2','https://vuejs.org/assets/inter-roman-latin.Cy4MYw_J.woff2'),
 ('Netlify js','https://vuejs.org/assets/app.B91ytTIH.js'),
 ('Vercel woff2','https://react.dev/fonts/Source-Code-Pro-Regular.woff2'),
 ('Cloudflare docs png','https://developers.cloudflare.com/favicon.png'),
 ('Cloudflare docs svg','https://developers.cloudflare.com/_astro/logo.te5VL_aD.svg'),
 ('Bunny jpg','https://bunny.net/images/bunnynet-the-best-content-delivery-network-cdn.jpg'),
 ('Bunny svg','https://bunny.net/images/bunny-cdn-icon-modern.svg'),
 ('B2 f001 js','https://f001.backblazeb2.com/file/backblaze-com-assets/codeSamples.js'),
 ('DO Spaces CDN svg','https://product-docs.nyc3.cdn.digitaloceanspaces.com/ai-agent-icon.svg'),
 ('Storj linkshare png','https://link.us1.storjshare.io/raw/jua7rls6hkx5556qfcmhrqed2tfa/docs/images/6lBTvetkB98edSAjvyB_q_root.png'),
 ('S3 default (noaa-goes16)','https://noaa-goes16.s3.amazonaws.com/index.html'),
 ('Blossom primal','https://blossom.primal.net/%s.pdf'%H),
 ('Blossom satellite','https://cdn.satellite.earth/%s.pdf'%H),
 ('Blossom nostr.download','https://nostr.download/%s.pdf'%H),
 ('Blossom hzrd149','https://cdn.hzrd149.com/%s.pdf'%H),
 ('IPFS ipfs.io','https://ipfs.io/ipfs/%s'%CID),
 ('IPFS dweb.link','https://dweb.link/ipfs/%s'%CID),
 ('IPFS w3s.link','https://w3s.link/ipfs/%s'%CID),
 ('IPFS storacha.link','https://storacha.link/ipfs/%s'%CID),
 ('IPFS pinata gw','https://gateway.pinata.cloud/ipfs/%s'%CID),
 ('IPFS filebase','https://ipfs.filebase.io/ipfs/%s'%CID),
 ('IPFS trustless-gateway.link','https://trustless-gateway.link/ipfs/%s'%CID),
 ('IPFS 4everland','https://4everland.io/ipfs/%s'%CID),
 ('IPFS cloudflare-ipfs','https://cloudflare-ipfs.com/ipfs/%s'%CID),
 ('jsDelivr npm','https://cdn.jsdelivr.net/npm/webtorrent@3.0.21/dist/webtorrent.min.js'),
 ('unpkg npm','https://unpkg.com/webtorrent@3.0.21/dist/webtorrent.min.js'),
 ('GitHub raw','https://raw.githubusercontent.com/hzrd149/blossom/master/buds/01.md'),
 ('CloudFront aws.amazon.com static','https://a0.awsstatic.com/libra-css/images/logos/aws_smile-header-desktop-en-white_59x35.png'),
]
KEEP=['access-control-allow-origin','access-control-allow-headers','access-control-allow-methods','access-control-expose-headers','access-control-max-age','accept-ranges','content-range','content-length','content-encoding','content-type','cache-control','server','via','alt-svc','vary','x-cache','cf-cache-status','age','location','strict-transport-security','x-amz-cors','x-ipfs-path']
def curl(method, url, headers, rng=None):
    cmd=['curl','-s','-D','-','-o','/dev/null','-m','25','-X',method,'--compressed-none']
    cmd.remove('--compressed-none')
    for h in headers: cmd+=['-H',h]
    cmd.append(url)
    t=time.time()
    p=subprocess.run(cmd,capture_output=True,text=True)
    out=p.stdout
    # take the LAST header block (after redirects not followed: we do not follow)
    blocks=[b for b in re.split(r'\r?\n\r?\n',out) if b.strip()]
    if not blocks: return {'status':'ERR rc=%d %s'%(p.returncode,p.stderr.strip()[:80])}
    b=blocks[-1].split('\n')
    d={'status':b[0].strip()}
    for line in b[1:]:
        if ':' in line:
            k,v=line.split(':',1); k=k.strip().lower(); v=v.strip()
            if k in KEEP: d[k]=v if k not in d else d[k]+' | '+v
    return d
def run(label,url):
    res={'label':label,'url':url}
    base=['Origin: https://example.org','Accept-Encoding: gzip, br']
    res['get_range']=curl('GET',url,base+['Range: bytes=0-99','Cache-Control: no-store','User-Agent: WebTorrent/3.0.21 (https://webtorrent.io)'])
    res['opt_stock']=curl('OPTIONS',url,['Origin: https://example.org','Access-Control-Request-Method: GET','Access-Control-Request-Headers: cache-control,range,user-agent'])
    res['opt_range_only']=curl('OPTIONS',url,['Origin: https://example.org','Access-Control-Request-Method: GET','Access-Control-Request-Headers: range'])
    return res
if __name__=='__main__':
    only=sys.argv[1:] 
    out=[]
    for label,url in TARGETS:
        if only and not any(o.lower() in label.lower() for o in only): continue
        r=run(label,url); out.append(r)
        g=r['get_range']; o=r['opt_stock']; o2=r['opt_range_only']
        print('##',label,url)
        for name,x in (('GET Range 0-99',g),('OPTIONS stock (cache-control,range,user-agent)',o),('OPTIONS range-only',o2)):
            print('  ',name,'->',x.get('status'))
            for k in KEEP:
                if k in x and k!='status': print('       ',k+':',x[k][:200])
        sys.stdout.flush()
    json.dump(out,open('/private/tmp/claude-501/-Users-owner/2e31ae61-4460-4879-804d-f5507c05cdbe/scratchpad/w2a07/out/survey.json','w' if not only else 'a'),indent=1)
