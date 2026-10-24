"""COS data-plane isolation, image validation and lease cancellation regressions."""
import hashlib
import io
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT/'Mac')]
from PIL import Image
from shared.compute.worker import CosHTTP, TaskRunner, prepare_cos_input, file_info
from shared.compute.client import MacComputeError

HOST='fixture-123456.cos.ap-guangzhou.myqcloud.com'
KEY='shiyan-web/assets/owner/input-id'

class Response:
    def __init__(self, data=b'image', status=200):self.data=io.BytesIO(data);self.status=status;self.size=len(data)
    def getheader(self,name,default=None):return str(self.size) if name.lower()=='content-length' else default
    def read1(self,size):return self.data.read(size)

class Connection:
    calls=[]
    def __init__(self,host,port,timeout):
        self.host=host;self.port=port;self.timeout=timeout;self.headers={};self.sent=b'';self.response=Response();self.sock=None;self.closed=False
        self.calls.append(self)
    def request(self,method,target,headers):self.method=method;self.target=target;self.headers=headers
    def putrequest(self,method,target):self.method=method;self.target=target
    def putheader(self,name,value):self.headers[name]=value
    def endheaders(self):pass
    def send(self,block):self.sent+=block
    def getresponse(self):return self.response
    def close(self):self.closed=True

def plan(method='GET',headers=None):
    return {'method':method,'url':f'https://{HOST}/{KEY}?q-signature=fixture','headers':headers or {'If-Match':'"'+'a'*32+'"'}}

class CosWorkerTests(unittest.TestCase):
    def test_direct_get_never_carries_broker_credentials_or_fixed_ip(self):
        with tempfile.TemporaryDirectory() as root:
            output=Path(root)/'input.img'
            CosHTTP(HOST,threading.Event(),connection_factory=Connection).transfer(plan(),KEY,destination=output,expected_size=5,limit=40)
            con=Connection.calls[-1]
            self.assertEqual(con.host,HOST);self.assertEqual(con.headers,plan()['headers']);self.assertEqual(output.read_bytes(),b'image')
            self.assertNotIn('Authorization',con.headers);self.assertNotIn('X-Task-Lease',con.headers)
            self.assertFalse(hasattr(con,'_create_connection'))
    def test_put_is_private_and_carries_only_signed_file_headers(self):
        with tempfile.TemporaryDirectory() as root:
            source=Path(root)/'result.jpg';source.write_bytes(b'jpeg')
            headers={'Content-Type':'image/jpeg','Content-Length':'4','x-cos-acl':'private','x-cos-meta-sha256':hashlib.sha256(b'jpeg').hexdigest()}
            CosHTTP(HOST,threading.Event(),connection_factory=Connection).transfer(plan('PUT',headers),KEY,source=source)
            con=Connection.calls[-1];self.assertEqual(con.sent,b'jpeg');self.assertEqual(con.headers,headers)
    def test_other_hosts_paths_and_broker_headers_are_rejected(self):
        http=CosHTTP(HOST,threading.Event(),connection_factory=Connection)
        with tempfile.TemporaryDirectory() as root:
            dest=Path(root)/'input'
            for change in [dict(url='https://127.0.0.1/private?q-signature=x'),dict(url=f'https://{HOST}/other?q-signature=x'),dict(headers={'If-Match':'etag','Authorization':'secret'})]:
                with self.assertRaises(ValueError):http.transfer({**plan(),**change},KEY,destination=dest,expected_size=5)
    def test_redirect_and_wrong_size_fail_without_leaking_signed_url(self):
        def factory(status=200):
            def make(*args,**kw):
                c=Connection(*args,**kw);c.response=Response(status=status);return c
            return make
        with tempfile.TemporaryDirectory() as root:
            for status,size in [(302,5),(200,4)]:
                with self.assertRaises(MacComputeError) as error:
                    CosHTTP(HOST,threading.Event(),connection_factory=factory(status)).transfer(plan(),KEY,destination=Path(root)/'image',expected_size=size)
                self.assertNotIn('q-signature',str(error.exception))
                self.assertFalse((Path(root)/'image').exists())
    def test_cancellation_interrupts_blocked_network(self):
        started=threading.Event()
        class Blocked(Connection):
            def __init__(self,*a,**kw):super().__init__(*a,**kw);self.sock=self;self.wake=threading.Event()
            def getresponse(self):started.set();self.wake.wait(3);raise OSError('closed')
            def shutdown(self,how):self.wake.set()
            def close(self):super().close();self.wake.set()
        lost=threading.Event();timer=threading.Timer(.1,lost.set);timer.start();begin=time.monotonic()
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(MacComputeError):CosHTTP(HOST,lost,connection_factory=Blocked).transfer(plan(),KEY,destination=Path(root)/'in',expected_size=5)
        timer.join();self.assertLess(time.monotonic()-begin,1.5)
    def test_normalization_is_lossless_png_with_existing_dimension_bound(self):
        with tempfile.TemporaryDirectory() as root:
            original,target=Path(root)/'original.png',Path(root)/'model.png'
            Image.new('RGBA',(3500,700),(20,30,40,128)).save(original)
            metadata=prepare_cos_input(original,target)
            with Image.open(target) as result:
                self.assertEqual(result.format,'PNG');self.assertEqual(result.size,(3000,600));self.assertEqual(result.mode,'RGBA')
            self.assertEqual(metadata['sha256'],file_info(target)['sha256'])
    def test_cos_runner_uses_only_broker_metadata_and_generates_thumbnail(self):
        owner='account:test';scope=hashlib.sha256(owner.encode()).hexdigest();identifier='11111111-1111-4111-8111-111111111111'
        input_meta={'id':identifier,'key':f'shiyan-web/assets/{scope}/input-{identifier}','bytes':500,'etag':'"'+'a'*32+'"','name':'input.png','mime':'image/png'}
        task={'id':identifier,'kind':'enhance_cos','owner_id':owner,'cos_host':HOST,'lease_token':'lease','params':{'model':'anime','input':input_meta}}
        calls=[];transfers=[]
        class Broker:
            def request(self,method,route,lease=None,payload=None,**kw):
                self_outer.assertFalse(kw,'Broker must never receive files')
                calls.append((method,route,payload))
                return {'headers':{'If-Match':input_meta['etag']}} if route.endswith('/cos-input') else {}
        class Direct:
            def __init__(self,*args):pass
            def transfer(self,plan,key,**kwargs):
                transfers.append(key)
                if kwargs.get('destination'):Image.new('RGB',(100,150),'red').save(kwargs['destination'],'PNG')
                else:self_outer.assertTrue(Path(kwargs['source']).is_file())
        self_outer=self
        runner=TaskRunner(Broker(),task,{})
        def engine(command):Image.new('RGB',(400,600),'red').save(command[-2],'JPEG')
        runner.run_process=engine
        with tempfile.TemporaryDirectory() as root,patch('shared.compute.worker.CosHTTP',Direct):runner.execute_cos(Path(root),task['params'])
        self.assertEqual(len(transfers),3);self.assertEqual(calls[-1][2],{'transport':'cos'})
        specs=[payload for _,route,payload in calls if route.endswith('/cos-output')]
        self.assertEqual([x['kind'] for x in specs],['output','thumbnail'])
        self.assertTrue(all(x['inputWidth']==100 and x['inputHeight']==150 for x in specs))

if __name__=='__main__':unittest.main()
