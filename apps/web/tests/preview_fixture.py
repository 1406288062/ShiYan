"""Synthetic documents only: no real user data is used by preview tests."""
import base64
import io
from zipfile import ZipFile, ZIP_DEFLATED


def docx_bytes():
    xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'''
    w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    rel = 'http://schemas.openxmlformats.org/package/2006/relationships'
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=')
    body = f'''<w:document xmlns:w="{w}" xmlns:r="{r}"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Web preview fixture</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/><w:color w:val="245A81"/></w:rPr><w:t>中文、bold text and an image</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="914400" cy="457200"/><wp:docPr id="1" name="Fixture image"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="fixture.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Column A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Column B</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Value one</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>Second page</w:t></w:r></w:p>
<w:sectPr><w:headerReference w:type="default" r:id="rHeader"/><w:footerReference w:type="default" r:id="rFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360"/></w:sectPr></w:body></w:document>'''
    contents = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>',
        '_rels/.rels': f'<Relationships xmlns="{rel}"><Relationship Id="rDoc" Type="{r}/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/_rels/document.xml.rels': f'<Relationships xmlns="{rel}"><Relationship Id="rStyles" Type="{r}/styles" Target="styles.xml"/><Relationship Id="rImage" Type="{r}/image" Target="media/fixture.png"/><Relationship Id="rHeader" Type="{r}/header" Target="header1.xml"/><Relationship Id="rFooter" Type="{r}/footer" Target="footer1.xml"/></Relationships>',
        'word/document.xml': body,
        'word/styles.xml': f'<w:styles xmlns:w="{w}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>',
        'word/header1.xml': f'<w:hdr xmlns:w="{w}"><w:p><w:r><w:t>Fixture header</w:t></w:r></w:p></w:hdr>',
        'word/footer1.xml': f'<w:ftr xmlns:w="{w}"><w:p><w:r><w:t>Fixture footer</w:t></w:r></w:p></w:ftr>',
        'word/media/fixture.png': png,
    }
    stream = io.BytesIO()
    with ZipFile(stream, 'w', ZIP_DEFLATED) as archive:
        for name, value in contents.items():
            archive.writestr(name, value if isinstance(value, bytes) else xml + value)
    return stream.getvalue()


def pdf_bytes():
    content = b"BT /F1 18 Tf 30 350 Td (Workspace PDF preview) Tj ET\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    raw = bytearray(b"%PDF-1.4\n");offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(raw));raw.extend(str(index).encode()+b" 0 obj\n"+obj+b"\nendobj\n")
    xref=len(raw);raw.extend(b"xref\n0 6\n0000000000 65535 f \n")
    for offset in offsets[1:]:raw.extend(f"{offset:010d} 00000 n \n".encode())
    raw.extend(b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n"+str(xref).encode()+b"\n%%EOF\n")
    return bytes(raw)
