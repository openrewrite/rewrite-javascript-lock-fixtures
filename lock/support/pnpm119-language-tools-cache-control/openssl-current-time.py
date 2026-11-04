#!/usr/bin/env python3
import os,sys
args=sys.argv[1:];out=[];i=0
while i<len(args):
 if args[i] in ('-not_before','-not_after'): i+=2
 else: out.append(args[i]);i+=1
if args[0] in ('req','x509'):out+=['-days','365']
os.execv('/usr/bin/openssl',['openssl',*out])
