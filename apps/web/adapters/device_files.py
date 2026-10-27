"""Audited, fixed filesystem helper used by the web remote-workspace adapter.

The helper is deliberately self contained.  It is sent to an already selected
device through the existing Sponge ``start_process`` tool; it never accepts a
shell command or Python source from the browser.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import textwrap


SCRIPT = textwrap.dedent(r'''
    import base64, difflib, errno, fcntl, hashlib, json, mimetypes, os, re, shutil, stat, subprocess, sys, tempfile, time

    TEXT_LIMIT = 2 * 1024 * 1024
    IMAGE_LIMIT = 4 * 1024 * 1024
    DOCUMENT_LIMIT = 4 * 1024 * 1024
    PDF_LIMIT = 4 * 1024 * 1024
    MAX_ENTRIES = 2000
    MAX_SEARCH_ENTRIES = 40000
    MAX_SEARCH_DIRS = 4096
    MAX_STAGE_CHUNKS = 256
    MAX_STAGE_BYTES = TEXT_LIMIT * 2
    MAX_DIFF_BYTES = 512 * 1024
    EXCLUDED = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', 'build', 'dist', '.Trash', '.cache', '.shiyan-web-state'}
    IMAGE_MIMES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'}
    ID_RE = re.compile(r'^[A-Za-z0-9_-]{8,128}$')

    def fail(message):
        raise ValueError(message)

    def write_all(fd, data):
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if count <= 0: fail('远端文件写入失败')
            view = view[count:]

    def mkdir_child(parent, name):
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        return open_component(parent, name, True)

    def one(value, name, limit=4096):
        if not isinstance(value, str) or not value or len(value) > limit or '\x00' in value:
            fail(name + '无效')
        return value

    def rel_parts(value, allow_empty=False):
        if value is None:
            value = ''
        elif allow_empty and value == '':
            value = ''
        else:
            value = one(value, '文件路径')
        if value.startswith('/') or '\\' in value:
            fail('文件路径无效')
        parts = [part for part in value.split('/') if part not in ('', '.')]
        if any(part == '..' or '\x00' in part for part in parts) or (not parts and not allow_empty):
            fail('文件路径无效')
        return parts

    def fd_dir(fd):
        return os.fstat(fd)

    def open_component(parent, name, directory=True):
        flags = os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) | os.O_NOFOLLOW
        if directory:
            flags |= os.O_DIRECTORY
        try:
            fd = os.open(name, flags, dir_fd=parent)
        except (FileNotFoundError, NotADirectoryError, PermissionError, OSError) as exc:
            fail('远端路径不存在或不可访问')
        info = os.fstat(fd)
        if directory and not stat.S_ISDIR(info.st_mode):
            os.close(fd); fail('远端路径不是目录')
        if not directory and not stat.S_ISREG(info.st_mode):
            os.close(fd); fail('远端文件不是普通文件')
        return fd

    def open_root(value):
        value = one(value, '项目路径')
        if not os.path.isabs(value):
            fail('项目路径必须是绝对路径')
        parts = [part for part in value.split('/') if part]
        fd = os.open('/', os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in parts:
                if part in ('.', '..') or '/' in part or '\\' in part:
                    fail('项目路径无效')
                nxt = open_component(fd, part, True)
                os.close(fd); fd = nxt
            return fd
        except BaseException:
            try: os.close(fd)
            except OSError: pass
            raise

    def cache_dir(root_value, rootfd):
        """Return a private, root-bound cache directory opened without symlinks."""
        canonical = canonical_root(root_value)
        home = os.path.expanduser('~')
        homefd = open_root(home)
        try:
            local = mkdir_child(homefd, '.local')
            try:
                state = mkdir_child(local, 'state')
                try:
                    service = mkdir_child(state, 'shiyan-web')
                    try:
                        key = hashlib.sha256(canonical.encode('utf-8')).hexdigest()
                        project = mkdir_child(service, key)
                        try:
                            binding = 'root-binding.json'
                            expected = json.dumps({'root': canonical}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                            try:
                                bfd = open_component(project, binding, False)
                                try: existing = os.read(bfd, len(expected) + 1)
                                finally: os.close(bfd)
                                if existing != expected: fail('项目缓存绑定不匹配')
                            except ValueError:
                                bfd = os.open(binding, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=project)
                                try: write_all(bfd, expected); os.fsync(bfd)
                                finally: os.close(bfd)
                            return project, canonical
                        except BaseException:
                            os.close(project)
                            raise
                    finally: os.close(service)
                finally: os.close(state)
            finally: os.close(local)
        finally: os.close(homefd)

    def open_relative(rootfd, parts, directory=False):
        current = os.dup(rootfd)
        try:
            if not parts:
                if not directory: fail('文件路径无效')
                return current, ''
            for part in parts[:-1]:
                nxt = open_component(current, part, True)
                os.close(current); current = nxt
            final = parts[-1]
            if directory:
                nxt = open_component(current, final, True)
            else:
                nxt = open_component(current, final, False)
            os.close(current)
            return nxt, final
        except BaseException:
            try: os.close(current)
            except OSError: pass
            raise

    def open_parent(rootfd, parts):
        if not parts: fail('文件路径无效')
        current = os.dup(rootfd)
        try:
            for part in parts[:-1]:
                nxt = open_component(current, part, True)
                os.close(current); current = nxt
            return current, parts[-1]
        except BaseException:
            try: os.close(current)
            except OSError: pass
            raise

    def rel_name(parts):
        return '/'.join(parts)

    def canonical_root(value):
        fd = open_root(value)
        try:
            # Every component was opened O_NOFOLLOW, so this is only used as a
            # display path and cannot change the directory used by later calls.
            return os.path.realpath(value)
        finally:
            os.close(fd)

    def info_for(entry, relative):
        try:
            info = entry.stat(follow_symlinks=False)
            link = entry.is_symlink()
            directory = (not link) and stat.S_ISDIR(info.st_mode)
            return {'name': entry.name, 'path': relative, 'directory': directory,
                    'blocked': link, 'symlink': link, 'bytes': info.st_size,
                    'modifiedAt': info.st_mtime}
        except OSError:
            return None

    def list_dir(args):
        rootfd = open_root(one(args.get('root'), '项目路径'))
        try:
            parts = rel_parts(args.get('path', ''), allow_empty=True)
            folder, _ = open_relative(rootfd, parts, True)
            try:
                rows = []
                seen = 0
                truncated = False
                with os.scandir(folder) as scan:
                    for entry in scan:
                        if entry.name in EXCLUDED:
                            continue
                        seen += 1
                        if len(rows) >= MAX_ENTRIES:
                            truncated = True
                            break
                        item = info_for(entry, rel_name(parts + [entry.name]))
                        if item is not None: rows.append(item)
                rows.sort(key=lambda x: (not x['directory'], x['name'].casefold()))
                total = seen
                offset = args.get('offset', 0)
                if not isinstance(offset, int) or offset < 0 or offset > 100000:
                    fail('目录分页参数无效')
                limit = min(max(int(args.get('limit', 100)), 1), 200)
                return {'path': rel_name(parts), 'name': os.path.basename(one(args.get('root'), '项目路径')) if not parts else parts[-1],
                        'total': total, 'totalKnown': not truncated, 'truncated': truncated,
                        'offset': offset, 'entries': rows[offset:offset + limit],
                        'nextOffset': offset + limit if offset + limit < total else None}
            finally:
                os.close(folder)
        finally:
            os.close(rootfd)

    def search(args):
        root_value = one(args.get('root'), '项目路径')
        query = args.get('q', '')
        if not isinstance(query, str) or len(query) > 160:
            fail('搜索条件无效')
        query = query.strip().casefold()
        if not query: return {'entries': [], 'truncated': False, 'searched': 0, 'omittedGeneratedFolders': sorted(EXCLUDED)}
        rootfd = open_root(root_value)
        rows, searched, truncated = [], 0, False
        stack = [[]]
        visited_dirs = 0
        deadline = time.monotonic() + 2.5
        try:
            while stack and not truncated:
                prefix = stack.pop()
                visited_dirs += 1
                if visited_dirs > MAX_SEARCH_DIRS:
                    truncated = True
                    break
                folder, _ = open_relative(rootfd, prefix, True)
                try:
                    with os.scandir(folder) as scan:
                        entries = []
                        for entry in scan:
                            if entry.name not in EXCLUDED:
                                entries.append(entry.name)
                            if len(entries) >= MAX_ENTRIES:
                                truncated = True
                                break
                    entries.sort(key=str.casefold, reverse=True)
                    for name in entries:
                        searched += 1
                        if searched > MAX_SEARCH_ENTRIES or time.monotonic() > deadline or len(rows) >= 300:
                            truncated = True; break
                        relative = rel_name(prefix + [name])
                        try:
                            child_info = os.stat(name, dir_fd=folder, follow_symlinks=False)
                            is_dir = stat.S_ISDIR(child_info.st_mode)
                            if not (is_dir or stat.S_ISREG(child_info.st_mode)):
                                continue
                            child_fd = open_component(folder, name, is_dir)
                            child_info = os.fstat(child_fd)
                            os.close(child_fd)
                        except (ValueError, OSError):
                            continue
                        item = {'name': name, 'path': relative, 'directory': is_dir,
                                'blocked': False, 'symlink': False, 'bytes': child_info.st_size,
                                'modifiedAt': child_info.st_mtime}
                        if item is None: continue
                        if query in relative.casefold(): rows.append(item)
                        if item['directory']:
                            if len(stack) >= MAX_SEARCH_DIRS:
                                truncated = True; break
                            stack.append(prefix + [name])
                finally:
                    os.close(folder)
            rows.sort(key=lambda x: (not x['directory'], x['path'].casefold()))
            return {'entries': rows, 'truncated': truncated, 'searched': searched,
                    'omittedGeneratedFolders': sorted(EXCLUDED)}
        finally:
            os.close(rootfd)

    def read_raw(rootfd, parts):
        fd, _ = open_relative(rootfd, parts, False)
        try:
            info = os.fstat(fd)
            if info.st_size > max(TEXT_LIMIT, IMAGE_LIMIT): fail('文件超过读取大小限制')
            chunks = []
            while True:
                data = os.read(fd, 1024 * 1024)
                if not data: break
                chunks.append(data)
                if sum(map(len, chunks)) > max(TEXT_LIMIT, IMAGE_LIMIT): fail('文件在读取过程中变大，请重试')
            return b''.join(chunks)
        finally:
            os.close(fd)

    def sensitive(parts):
        return (parts[-1] == '.env' or parts[-1].startswith('.env.') or
                os.path.splitext(parts[-1])[1].lower() in {'.pem', '.key', '.p12'} or
                any(part in {'.ssh', '.aws', '.codex'} for part in parts))

    def decode_text(raw):
        if b'\x00' in raw: return None, None
        try: return raw.decode('utf-8-sig'), 'UTF-8'
        except UnicodeDecodeError:
            try: return raw.decode('gb18030'), 'GB18030'
            except UnicodeDecodeError: return None, None

    def read_file(args):
        root_value = one(args.get('root'), '项目路径')
        parts = rel_parts(args.get('path'))
        rootfd = open_root(root_value)
        try:
            fd, _ = open_relative(rootfd, parts, False)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode): fail('文件不是普通文件')
                size = info.st_size
                mime = mimetypes.guess_type(parts[-1])[0] or 'application/octet-stream'
                base = {'name': parts[-1], 'path': rel_name(parts), 'bytes': size, 'size': size,
                        'mimeType': mime, 'sensitive': sensitive(parts)}
                ext = os.path.splitext(parts[-1])[1].lower()
                if ext == '.pdf':
                    if size > PDF_LIMIT: fail('PDF 超过 4 MiB 远端预览大小限制')
                    return {**base, 'kind': 'web-document', 'documentType': 'pdf',
                            'contentHash': hashlib.sha256(os.read(fd, 0)).hexdigest() if False else None}
                if ext == '.docx':
                    if size > DOCUMENT_LIMIT: fail('Word 文件超过远端预览大小限制')
                    return {**base, 'kind': 'web-document', 'documentType': 'docx'}
                limit = IMAGE_LIMIT if mime in IMAGE_MIMES else TEXT_LIMIT
                if size > limit: return {**base, 'kind': 'large', 'message': '文件超过预览上限，请用本地编辑器打开'}
                os.lseek(fd, 0, os.SEEK_SET)
                raw = b''
                while len(raw) <= limit:
                    chunk = os.read(fd, min(1024 * 1024, limit + 1 - len(raw)))
                    if not chunk: break
                    raw += chunk
                if len(raw) > limit: fail('文件在读取过程中变大，请重试')
                digest = hashlib.sha256(raw).hexdigest()
                if mime in IMAGE_MIMES:
                    return {**base, 'kind': 'image', 'dataUrl': 'data:' + mime + ';base64,' + base64.b64encode(raw).decode('ascii'), 'contentHash': digest}
                text, encoding = decode_text(raw)
                if text is None: return {**base, 'kind': 'binary', 'message': '无法识别此文件的文本编码'}
                newline = 'CRLF' if b'\r\n' in raw else 'CR' if b'\r' in raw else 'LF'
                return {**base, 'kind': 'text', 'text': text, 'encoding': encoding,
                        'language': os.path.splitext(parts[-1])[1].lower().lstrip('.'),
                        'contentHash': digest, 'newline': newline, 'bom': raw.startswith(b'\xef\xbb\xbf')}
            finally:
                os.close(fd)
        finally:
            os.close(rootfd)

    def raw_document(args):
        rootfd = open_root(one(args.get('root'), '项目路径'))
        try:
            parts = rel_parts(args.get('path'))
            fd, _ = open_relative(rootfd, parts, False)
            try:
                info = os.fstat(fd)
                limit = PDF_LIMIT if os.path.splitext(parts[-1])[1].lower() == '.pdf' else DOCUMENT_LIMIT
                if info.st_size > limit: fail('PDF 超过 4 MiB 传输大小限制' if limit == PDF_LIMIT else '文档超过传输大小限制')
                data = b''
                while len(data) <= limit:
                    chunk = os.read(fd, min(1024 * 1024, limit + 1 - len(data)))
                    if not chunk: break
                    data += chunk
                if len(data) > limit: fail('PDF 超过 4 MiB 传输大小限制' if limit == PDF_LIMIT else '文档超过传输大小限制')
                return {'name': parts[-1], 'path': rel_name(parts), 'dataB64': base64.b64encode(data).decode('ascii')}
            finally: os.close(fd)
        finally: os.close(rootfd)

    def safe_id(value):
        value = one(value, '标识', 128)
        if not ID_RE.fullmatch(value): fail('标识无效')
        return value

    def stage(args):
        stage_id = safe_id(args.get('stageId'))
        index = args.get('index'); total = args.get('total')
        if not isinstance(index, int) or not isinstance(total, int) or total < 1 or total > MAX_STAGE_CHUNKS or index < 0 or index >= total:
            fail('暂存分片无效')
        data = args.get('dataB64')
        if not isinstance(data, str) or len(data) > 100000: fail('暂存分片过大')
        try: chunk = base64.b64decode(data.encode('ascii'), validate=True)
        except Exception: fail('暂存分片编码无效')
        if len(chunk) > 24576: fail('暂存分片过大')
        root_value = one(args.get('root'), '项目路径')
        rootfd = open_root(root_value)
        cache = None; stages = None; folder = None; fd = None
        try:
            cache, _ = cache_dir(root_value, rootfd)
            stages = mkdir_child(cache, 'stages')
            folder = mkdir_child(stages, stage_id)
            target = '%08d.part' % index
            try:
                existing_fd = open_component(folder, target, False)
            except ValueError:
                pass
            else:
                os.close(existing_fd)
                fail('暂存分片重复')
            staged_bytes = len(chunk)
            with os.scandir(folder) as scan:
                for entry in scan:
                    if entry.name.endswith('.part'):
                        staged_bytes += entry.stat(follow_symlinks=False).st_size
            if staged_bytes > MAX_STAGE_BYTES: fail('暂存内容超过大小上限')
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
            write_all(fd, chunk); os.fsync(fd)
            return {'stageId': stage_id, 'index': index, 'total': total}
        except BaseException:
            cleanup_stage(root_value, stage_id)
            raise
        finally:
            if fd is not None: os.close(fd)
            if folder is not None: os.close(folder)
            if stages is not None: os.close(stages)
            if cache is not None: os.close(cache)
            os.close(rootfd)

    def staged_text(root_value, stage_id, total):
        stage_id = safe_id(stage_id)
        if not isinstance(total, int) or total < 1 or total > MAX_STAGE_CHUNKS: fail('暂存分片数量无效')
        rootfd = open_root(one(root_value, '项目路径'))
        parts = []
        cache = None; stages = None; folder = None
        try:
            cache, _ = cache_dir(root_value, rootfd)
            stages = open_component(cache, 'stages', True)
            folder = open_component(stages, stage_id, True)
            for index in range(total):
                fd = open_component(folder, '%08d.part' % index, False)
                try: parts.append(os.read(fd, 24577))
                finally: os.close(fd)
                if len(parts[-1]) > 24576: fail('暂存分片无效')
            raw = b''.join(parts)
            if len(raw) > MAX_STAGE_BYTES: fail('编辑内容超过大小上限')
            try: return raw.decode('utf-8')
            except UnicodeDecodeError: fail('编辑内容编码无效')
        finally:
            if folder is not None: os.close(folder)
            if stages is not None: os.close(stages)
            if cache is not None: os.close(cache)
            os.close(rootfd)

    def cleanup_stage(root_value, stage_id):
        if not isinstance(stage_id, str) or not ID_RE.fullmatch(stage_id): return
        rootfd = None
        cache = None; stages = None
        try:
            rootfd = open_root(one(root_value, '项目路径'))
            cache, _ = cache_dir(root_value, rootfd)
            stages = open_component(cache, 'stages', True)
            try:
                try: os.rmdir(stage_id, dir_fd=stages)
                except OSError:
                    folder = open_component(stages, stage_id, True)
                    try:
                        with os.scandir(folder) as scan:
                            for entry in scan:
                                try: os.unlink(entry.name, dir_fd=folder)
                                except OSError: pass
                    finally: os.close(folder)
                    try: os.rmdir(stage_id, dir_fd=stages)
                    except OSError: pass
            finally: os.close(stages); stages = None
        except (ValueError, OSError):
            pass
        finally:
            if stages is not None: os.close(stages)
            if cache is not None: os.close(cache)
            if rootfd is not None: os.close(rootfd)

    def normalized_text(text, newline):
        text = text.replace('\r\n', '\n').replace('\r', '\n')
        return text.replace('\n', {'CRLF': '\r\n', 'CR': '\r', 'LF': '\n'}.get(newline, '\n'))

    def receipt_paths(root_value, rootfd):
        cache, _ = cache_dir(root_value, rootfd)
        receipts = mkdir_child(cache, 'receipts')
        backups = mkdir_child(cache, 'backups')
        stages = mkdir_child(cache, 'stages')
        os.close(backups); os.close(stages)
        return receipts, cache

    def receipt_read(receipts, request_id):
        try:
            fd = open_component(receipts, request_id + '.json', False)
        except ValueError: return None
        try:
            raw = os.read(fd, 65537)
            return json.loads(raw.decode('utf-8')) if len(raw) <= 65536 else None
        except Exception: return None
        finally: os.close(fd)

    def receipt_write(receipts, request_id, value):
        temp = '.tmp-' + request_id
        raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        fd = None
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=receipts)
            write_all(fd, raw); os.fsync(fd)
            os.replace(temp, request_id + '.json', src_dir_fd=receipts, dst_dir_fd=receipts)
        finally:
            if fd is not None: os.close(fd)
            try: os.unlink(temp, dir_fd=receipts)
            except OSError: pass

    def project_lock(cache):
        fd = os.open('save.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=cache)
        try: fcntl.flock(fd, fcntl.LOCK_EX)
        except BaseException:
            os.close(fd)
            raise
        return fd

    def save(args):
        request_id = safe_id(args.get('requestId'))
        expected = args.get('contentHash')
        if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', expected): fail('文件版本标识无效')
        root_value = one(args.get('root'), '项目路径')
        rootfd = open_root(root_value)
        stage_id = args.get('stageId')
        lockfd = None
        temporary = None
        target_fd = None
        receipts = None
        cache = None
        parent = None
        try:
            parts = rel_parts(args.get('path'))
            receipts, cache = receipt_paths(root_value, rootfd)
            lockfd = project_lock(cache)
            prior = receipt_read(receipts, request_id)
            text = staged_text(root_value, stage_id, args.get('stageTotal')) if stage_id else None
            if text is None:
                value = args.get('textB64')
                if not isinstance(value, str): fail('编辑内容无效')
                try: text = base64.b64decode(value.encode('ascii'), validate=True).decode('utf-8')
                except Exception: fail('编辑内容编码无效')
            text_hash = hashlib.sha256(text.encode('utf-8')).hexdigest()
            canonical = canonical_root(root_value)
            if prior:
                fingerprint = prior.get('fingerprint') or {}
                payload_same = (fingerprint.get('newHash') == args.get('payloadHash')
                                if args.get('payloadHash') is not None
                                else fingerprint.get('textHash') == text_hash)
                same = (fingerprint.get('root') == canonical and fingerprint.get('path') == rel_name(parts)
                        and fingerprint.get('oldHash') == expected and payload_same)
                if same and isinstance(prior.get('result'), dict):
                    return dict(prior['result'], _receiptReplay=True)
                fail('相同 requestId 不得用于不同的保存内容')
            parent, name = open_parent(rootfd, parts)
            try:
                target = open_component(parent, name, False)
                try:
                    original_info = os.fstat(target)
                    original = b''
                    while len(original) <= TEXT_LIMIT:
                        chunk = os.read(target, min(1024 * 1024, TEXT_LIMIT + 1 - len(original)))
                        if not chunk: break
                        original += chunk
                    if len(original) > TEXT_LIMIT: fail('编辑内容超过文件大小上限')
                    first_hash = hashlib.sha256(original).hexdigest()
                finally: os.close(target)
                if first_hash != expected: fail('文件已被其他程序修改，请重新读取后再编辑')
                original_text, encoding = decode_text(original)
                if original_text is None: fail('二进制文件不支持文本编辑')
                newline = 'CRLF' if b'\r\n' in original else 'CR' if b'\r' in original else 'LF'
                bom = original.startswith(b'\xef\xbb\xbf')
                raw = normalized_text(text, newline).encode('gb18030' if encoding == 'GB18030' else 'utf-8')
                if bom and encoding == 'UTF-8': raw = b'\xef\xbb\xbf' + raw
                if len(raw) > TEXT_LIMIT: fail('编辑内容超过文件大小上限')
                new_hash = hashlib.sha256(raw).hexdigest()
                if args.get('payloadHash') is not None and args.get('payloadHash') != new_hash:
                    fail('保存内容指纹无效')
                # Back up the exact bytes that passed the first version check
                # in the private cache, never in the user's repository.
                backups = open_component(cache, 'backups', True)
                try:
                    backup_name = request_id + '-' + name
                    bfd = os.open(backup_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=backups)
                    try: write_all(bfd, original); os.fsync(bfd)
                    finally: os.close(bfd)
                finally: os.close(backups)
                temporary = '.shiyan-web-' + request_id + '.tmp'
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                try:
                    os.fchmod(fd, stat.S_IMODE(original_info.st_mode))
                    write_all(fd, raw); os.fsync(fd)
                finally: os.close(fd)
                # This check is intentionally after complete temp write/fsync
                # and immediately before the atomic replace.
                target_fd = open_component(parent, name, False)
                current_info = os.fstat(target_fd)
                current = b''
                while len(current) <= TEXT_LIMIT:
                    chunk = os.read(target_fd, min(1024 * 1024, TEXT_LIMIT + 1 - len(current)))
                    if not chunk: break
                    current += chunk
                if ((current_info.st_dev, current_info.st_ino) != (original_info.st_dev, original_info.st_ino)
                        or hashlib.sha256(current).hexdigest() != expected):
                    fail('保存前文件发生变化，编辑内容未覆盖原文件')
                os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
                temporary = None
                os.fsync(parent)
                result = {'backupPath': os.path.expanduser('~') + '/.local/state/shiyan-web/' + hashlib.sha256(canonical.encode('utf-8')).hexdigest() + '/backups/' + backup_name,
                          'path': rel_name(parts), 'contentHash': new_hash, 'bytes': len(raw)}
                try:
                    receipt_write(receipts, request_id, {'fingerprint': {'root': canonical, 'path': rel_name(parts), 'oldHash': expected,
                                                                          'newHash': new_hash, 'textHash': text_hash}, 'result': result})
                except Exception:
                    fail('文件已替换但保存回执写入失败，状态不确定，请勿重复发送')
                return result
            finally:
                if temporary is not None:
                    try: os.unlink(temporary, dir_fd=parent)
                    except OSError: pass
                    temporary = None
                os.close(parent)
        finally:
            if target_fd is not None: os.close(target_fd)
            if lockfd is not None:
                try: fcntl.flock(lockfd, fcntl.LOCK_UN)
                finally: os.close(lockfd)
            if receipts is not None: os.close(receipts)
            if cache is not None: os.close(cache)
            cleanup_stage(root_value, stage_id)
            os.close(rootfd)

    def read_current_text(root_value, path):
        item = read_file({'root': root_value, 'path': path})
        if item.get('kind') != 'text': fail('此文件不支持文本变更预览')
        return item

    def changes(args):
        root_value = one(args.get('root'), '项目路径')
        current = read_current_text(root_value, args.get('path'))
        baseline = None; source = ''
        stage_id = args.get('baselineStage')
        if stage_id:
            try:
                baseline = staged_text(root_value, stage_id, args.get('baselineTotal')); source = '打开文件时'
            finally:
                cleanup_stage(root_value, stage_id)
        rootfd = open_root(root_value)
        try:
            if baseline is None:
                receipts, cache = receipt_paths(root_value, rootfd)
                try:
                    candidates = []
                    with os.scandir(receipts) as scan:
                        for entry in scan:
                            if not entry.name.endswith('.json'): continue
                            try:
                                rfd = open_component(receipts, entry.name, False)
                                try: item = json.loads(os.read(rfd, 65537).decode('utf-8'))
                                finally: os.close(rfd)
                                result = item.get('result', {})
                                if result.get('path') == current['path']:
                                    candidates.append((entry.stat().st_mtime, result.get('backupPath')))
                            except Exception: pass
                    if candidates:
                        candidates.sort(reverse=True)
                        backup = candidates[0][1]
                        backups = open_component(cache, 'backups', True)
                        bfd = open_component(backups, os.path.basename(str(backup)), False)
                        try: baseline, enc = decode_text(os.read(bfd, TEXT_LIMIT + 1))
                        finally:
                            os.close(bfd); os.close(backups)
                        if baseline is not None: source = '最近一次保存前'
                finally:
                    os.close(receipts); os.close(cache)
            if baseline is None:
                try:
                    probe = subprocess.run(['git', '-C', root_value, 'rev-parse', '--show-toplevel'], capture_output=True, text=True, timeout=5)
                    if probe.returncode == 0:
                        gitroot = probe.stdout.strip()
                        relative = os.path.relpath(os.path.join(root_value, current['path']), gitroot)
                        tracked = subprocess.run(['git', '-C', gitroot, 'ls-files', '--error-unmatch', '--', relative],
                                                 capture_output=True, text=True, timeout=5)
                        if tracked.returncode != 0:
                            baseline, source = '', '工作区新文件'
                        else:
                            show = subprocess.Popen(['git', '-C', gitroot, 'show', 'HEAD:' + relative], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                            saved = show.stdout.read(TEXT_LIMIT + 1) if show.stdout else b''
                            if len(saved) <= TEXT_LIMIT and show.wait(timeout=5) == 0:
                                baseline, _ = decode_text(saved); source = 'Git HEAD'
                            else:
                                show.kill(); show.wait()
                except (OSError, subprocess.TimeoutExpired): pass
            if baseline is None and isinstance(args.get('baselineText'), str) and len(args['baselineText'].encode('utf-8')) <= TEXT_LIMIT:
                baseline = args['baselineText']; source = '打开文件时'
            return {'name': current['name'], 'path': current['path'], 'currentText': current['text'],
                    'baselineText': baseline, 'source': source}
        finally: os.close(rootfd)

    def pick(args):
        platform = args.get('platform')
        if platform == 'darwin':
            result = subprocess.run(['osascript', '-e', 'POSIX path of (choose folder with prompt "选择远程项目目录")'], capture_output=True, text=True, timeout=120)
            if result.returncode != 0: return {'cancelled': True, 'path': ''}
            path = result.stdout.strip()
            return {'cancelled': not bool(path), 'path': os.path.realpath(path) if path else ''}
        return {'cancelled': False, 'path': os.path.expanduser('~')}

    def main():
        if len(sys.argv) != 2: fail('固定设备脚本参数无效')
        try: args = json.loads(base64.b64decode(sys.argv[1].encode('ascii'), validate=True).decode('utf-8'))
        except Exception: fail('固定设备脚本参数无效')
        if not isinstance(args, dict): fail('固定设备脚本参数无效')
        action = args.get('action')
        if action == 'validate_root': result = {'path': canonical_root(args.get('path'))}
        elif action == 'list': result = list_dir(args)
        elif action == 'search': result = search(args)
        elif action == 'read': result = read_file(args)
        elif action == 'raw': result = raw_document(args)
        elif action == 'stage': result = stage(args)
        elif action == 'save': result = save(args)
        elif action == 'changes': result = changes(args)
        elif action == 'pick': result = pick(args)
        elif action == 'cleanup': cleanup_stage(args.get('root'), args.get('stageId')); result = {'ok': True}
        else: fail('不支持的远端文件操作')
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False, separators=(',', ':')))

    try: main()
    except ValueError as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False, separators=(',', ':')))
        sys.exit(2)
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': '远端文件操作失败'}, ensure_ascii=False, separators=(',', ':')))
        sys.exit(3)
''').strip()


def command(args: dict) -> str:
    """Build the only command allowed to cross the device tool boundary."""
    if not isinstance(args, dict) or args.get("action") not in {
        "validate_root", "list", "search", "read", "raw", "stage", "save", "changes", "pick", "cleanup"
    }:
        raise ValueError("不支持的远端文件操作")
    encoded = base64.b64encode(json.dumps(args, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).decode("ascii")
    source = base64.b64encode(SCRIPT.encode("utf-8")).decode("ascii")
    # The source and arguments are fixed/audited values.  shlex.quote is done
    # by the caller because the transport command is consumed by start_process.
    return "python3 -I -c \"import base64;exec(compile(base64.b64decode(%s),'shiyan_remote_files.py','exec'))\" %s" % (repr(source), repr(encoded))


def encoded_text_chunks(text: str, size: int = 24576):
    raw = text.encode("utf-8")
    for offset in range(0, len(raw), size):
        yield raw[offset:offset + size]
