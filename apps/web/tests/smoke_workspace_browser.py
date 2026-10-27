"""Real Chromium interaction test; full app + real fixed remote helper.

Uses only temporary projects/accounts. No user data, running app, or deployment.
"""
from pathlib import Path
import json
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[3]))
from apps.web.tests.integration_fixture import Harness
from desktop_backend.account_sessions import COOKIE
from playwright.sync_api import sync_playwright, expect

OUT=Path('/tmp/shiyan-web-finish-20261027')


def main():
    OUT.mkdir(exist_ok=True)
    with Harness() as h, sync_playwright() as p:
        a=h.client();seed=h.seed(a)
        browser=p.chromium.launch(headless=True,executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        context=browser.new_context(viewport={'width':1500,'height':980},color_scheme='light')
        context.add_cookies([{'name':COOKIE,'value':a.cookies.get(COOKIE),'url':h.base,'httpOnly':True,'sameSite':'Strict'}])
        page=context.new_page();errors=[];requests=[]
        page.on('pageerror',lambda err: errors.append(str(err)))
        page.on('response',lambda response: requests.append((response.status,response.url)) if response.status>=400 else None)
        def shot(name):page.screenshot(path=str(OUT/name),full_page=True)
        try:
            page.goto(h.base,wait_until='domcontentloaded')
            for _ in range(100):
                if page.evaluate('Boolean(window.workbench?.ready)'):break
                page.wait_for_timeout(150)
            assert page.evaluate('Boolean(window.workbench?.ready)'),page.locator('body').inner_text()[:1200]
            if page.locator('#toggleRightWorkspace').get_attribute('aria-expanded')!='true':
                page.locator('#toggleRightWorkspace').click()
            page.locator('[data-web-add]:visible').first.wait_for(timeout=10000)
            print('PASS real web boot and device controls',flush=True)
            page.locator('[data-web-add]:visible').first.click()
            form=page.locator('[data-web-project-form]:visible').first
            form.locator('[data-web-form-device]').select_option('fixture-device')
            form.locator('[data-web-form-name]').fill('设备验收项目')
            form.locator('[data-web-form-path]').fill(str(h.project))
            form.locator('[data-web-submit]').click()
            pane=page.locator('#rightContent > .workspace-pane:not([hidden])')
            pane.locator('[data-file-path="src"]').click(timeout=15000)
            pane.locator('[data-file-path="src/main.py"]').click()
            expect(pane.locator('.source-code')).to_contain_text("print('before')",timeout=15000)
            print('PASS device project binding, directory tree and source preview',flush=True)
            shot('workspace-files-before.png')
            code=pane.locator('.source-code code')
            code.evaluate('(node)=>{const range=document.createRange();range.selectNodeContents(node);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event("selectionchange"));}')
            page.locator('#v22SelectionBar [data-selection-edit]').click()
            editor=page.locator('#v22TextEditor')
            expect(editor).to_be_visible()
            editor.locator('textarea').fill("print('browser changed')\n")
            editor.locator('[type="submit"]').click()
            expect(editor).to_be_hidden(timeout=20000)
            expect(pane.locator('.source-code')).to_contain_text('browser changed')
            assert h.source.read_text()=="print('browser changed')\n"
            assert h.source.stat().st_mode&0o777==0o755
            assert not (h.project/'.shiyan-web-state').exists()
            print('PASS shared selection editor and actual save/backup/mode preservation',flush=True)
            page.locator('.project-row[data-project="fixture-cloud-project"]').click()
            expect(page.locator('#rightContent > .workspace-pane:not([hidden]) .source-code')).to_contain_text('browser changed',timeout=10000)
            assert page.evaluate("window.shiyan.getState().conversations.find(c=>c.id===window.shiyan.getState().selectedConversationId).projectId")=='fixture-cloud-project'
            print('PASS left cloud project selection does not replace the right device project',flush=True)
            pane.locator('.v23-view-changes').click()
            diff=page.locator('.v24-changes-pane:not([hidden])')
            expect(diff).to_be_visible(timeout=10000)
            expect(diff).to_contain_text('browser changed')
            shot('workspace-file-diff.png')
            print('PASS shared diff view',flush=True)
            # Conversation changes and execution use the desktop's existing components.
            page.locator('[data-show-message-changes="fixture-assistant-message"]').first.click()
            expect(diff).to_contain_text('print(2)')
            page.locator('[data-open-execution="fixture-assistant-message"]').first.click()
            expect(page.locator('.execution-pane:not([hidden])')).to_be_visible()
            expect(page.locator('.execution-pane:not([hidden])')).to_contain_text('python3 --version')
            print('PASS message changes card and execution history',flush=True)
            # Server document preview is the same right file panel, not a new modal.
            page.locator('[data-asset-id="'+seed['word']['id']+'"]').first.click()
            preview=page.locator('#rightContent .workspace-pane:not([hidden]) iframe[data-web-document-preview]')
            expect(preview).to_be_visible()
            word=page.frame_locator('#rightContent .workspace-pane:not([hidden]) iframe[data-web-document-preview]')
            word.locator('html[data-preview-ready="true"]').wait_for(timeout=20000)
            assert word.locator('section.docx').count()==2
            assert word.get_by_text('Fixture header',exact=True).count()>=1
            shot('workspace-word-preview.png')
            print('PASS server Word preview in shared file pane',flush=True)
            # Original file download remains accessible from preview.
            with page.expect_download(timeout=10000) as download:
                page.locator('#rightContent .workspace-pane:not([hidden]) [data-web-download]').click()
            assert download.value.suggested_filename.endswith('.docx')
            print('PASS original Word download',flush=True)
            # Return to the bound device project using the existing control.
            device_project=a.get('/api/web-workspace/projects').json()['projects'][0]['id']
            page.locator('#rightContent .workspace-pane:not([hidden]) [data-web-project]').select_option(device_project)
            pane=page.locator('#rightContent > .workspace-pane:not([hidden])')
            pane.locator('input[type="search"]').fill('main')
            expect(pane.locator('.v2-file-matches')).to_contain_text('main.py',timeout=10000)
            pane.locator('input[type="search"]').fill('')
            pane.locator('[data-file-path="report.docx"]').click()
            remote_frame=page.frame_locator('#rightContent .workspace-pane:not([hidden]) iframe[data-web-document-preview]')
            remote_frame.locator('html[data-preview-ready="true"]').wait_for(timeout=20000)
            print('PASS remote search and device Word preview',flush=True)
            # PDF uses the browser's own inline viewer; no local device upload.
            page.locator('[data-asset-id="'+seed['pdf']['id']+'"]').first.click()
            pdfview=page.locator('#rightContent .workspace-pane:not([hidden]) iframe[data-web-document-preview]')
            expect(pdfview).to_be_visible()
            assert '/api/web-workspace/preview/' in pdfview.get_attribute('src')
            pdfresponse=a.get(pdfview.get_attribute('src'))
            assert pdfresponse.status_code==200 and pdfresponse.headers['content-type'].startswith('application/pdf')
            assert pdfresponse.content.startswith(b'%PDF-')
            print('PASS server PDF inline preview',flush=True)
            await_count=page.evaluate('window.workbench.getLayout().tabCount')
            page.wait_for_timeout(600)
            page.reload(wait_until='domcontentloaded')
            for _ in range(100):
                if page.evaluate('Boolean(window.workbench?.ready)'):break
                page.wait_for_timeout(100)
            expect(page.locator('#rightContent .workspace-pane:not([hidden]) iframe[data-web-document-preview]')).to_be_visible(timeout=12000)
            assert page.evaluate('window.workbench.getLayout().tabCount')==await_count
            assert '/preview/'+seed['pdf']['id'] in page.locator('#rightContent .workspace-pane:not([hidden]) iframe').get_attribute('src')
            print('PASS reload restores the selected attachment without duplicate tabs',flush=True)
            assert not errors,errors
            for selector in ['#browserAddressBar','#bottomTerminal','[data-workspace-temporary]']:
                assert page.locator(selector+':visible').count()==0,selector
            assert '设备验收项目' not in page.locator('#projectList').inner_text()
            print('PASS hidden browser/terminal, left project isolation, no JS errors',flush=True)
            (OUT/'browser-result.json').write_text(json.dumps({'passed':True,'javascriptErrors':errors,'httpErrors':requests},ensure_ascii=False,indent=2))
        except BaseException:
            try:
                shot('workspace-failure.png')
                (OUT/'browser-failure.txt').write_text(page.locator('body').inner_text()+'\n\nERRORS\n'+json.dumps(errors,ensure_ascii=False)+'\nHTTP\n'+json.dumps(requests,ensure_ascii=False),encoding='utf-8')
            except Exception:pass
            raise
        finally:context.close();browser.close()


if __name__=='__main__':main()
