import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile
sys.path.insert(0,str(Path(__file__).resolve().parents[3]))
from fastapi import HTTPException
from apps.web.adapters.document_preview import checked_docx, render_docx, DOCX_CSP
from apps.web.tests.preview_fixture import docx_bytes


class DocumentPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'fixture.docx'
        self.path.write_bytes(docx_bytes())

    def test_rich_preview_uses_local_assets_and_inert_bytes(self):
        text = render_docx(self.path)
        self.assertEqual(text.count('<script>'),3)
        self.assertIn('<template id="documentBytes">',text)
        self.assertNotIn('<script src=',text)
        self.assertEqual(DOCX_CSP.count("'sha256-"),3)
        self.assertIn('sandbox allow-scripts',DOCX_CSP)
        self.assertIn("connect-src 'none'",DOCX_CSP)
        self.assertNotIn('allow-same-origin',DOCX_CSP)

    def test_not_a_document_fails(self):
        self.path.write_bytes(b'bad file')
        with self.assertRaises(HTTPException) as err: checked_docx(self.path)
        self.assertEqual(err.exception.status_code,415)

    def test_compressed_size_limit(self):
        with patch('apps.web.adapters.document_preview.MAX_DOCX',1):
            with self.assertRaises(HTTPException) as err: checked_docx(self.path)
        self.assertEqual(err.exception.status_code,413)

    def test_expansion_limit(self):
        with patch('apps.web.adapters.document_preview.MAX_EXPANDED',1):
            with self.assertRaises(HTTPException) as err: checked_docx(self.path)
        self.assertEqual(err.exception.status_code,413)

    def test_xml_entities_rejected(self):
        for value in [b'<!DOCTYPE x [<!ENTITY test "a">]><x/>','<!DOCTYPE x><x/>'.encode('utf-16')]:
            with ZipFile(self.path,'w') as archive:
                archive.writestr('[Content_Types].xml','<Types/>')
                archive.writestr('word/document.xml',value)
            with self.assertRaises(HTTPException) as err: checked_docx(self.path)
            self.assertEqual(err.exception.status_code,415)

    def test_traversal_zip_rejected(self):
        with ZipFile(self.path,'a') as archive: archive.writestr('../escape.xml','<x/>')
        with self.assertRaises(HTTPException) as err: checked_docx(self.path)
        self.assertEqual(err.exception.status_code,415)


if __name__=='__main__': unittest.main()
