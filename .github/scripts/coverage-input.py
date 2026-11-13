"""Validate coverage and source ZIPs without extracting executable repository content."""

import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

LIMIT = 32 * 1024 * 1024
FILE_LIMIT = 8 * 1024 * 1024


def members(path, source=False):
    if path.stat().st_size > LIMIT:
        raise ValueError('archive too large')
    archive = zipfile.ZipFile(path)
    infos = archive.infolist()
    if len(infos) > 10000 or sum(i.file_size for i in infos) > 128 * 1024 * 1024:
        raise ValueError('archive expands beyond limit')
    names = set()
    for info in infos:
        name = info.filename.rstrip('/')
        parts = name.split('/')
        mode = info.external_attr >> 16
        if (
            not re.fullmatch(r'[A-Za-z0-9_. /@+-]+', name)
            or any(p in ('', '.', '..') for p in parts)
            or name in names
            or info.flag_bits & 1
            or stat.S_IFMT(mode)
            not in (0, stat.S_IFREG, stat.S_IFDIR, *([stat.S_IFLNK] if source else []))
            or info.file_size > FILE_LIMIT
        ):
            raise ValueError('unsafe archive member')
        names.add(name)
    return archive


def source_files(path):
    with members(path, source=True) as archive:
        roots = {i.filename.split('/')[0] for i in archive.infolist()}
        if len(roots) != 1:
            raise ValueError('source archive must have one root')
        files = {}
        for info in archive.infolist():
            path = PurePosixPath(info.filename)
            relative = str(PurePosixPath(*path.parts[1:]))
            if not info.is_dir() and (
                relative.endswith('.go')
                or (
                    relative.startswith('internal/frontend/src/')
                    and relative.endswith(('.ts', '.tsx'))
                )
            ):
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise ValueError('source symlink is not a regular file')
                files[relative] = archive.read(info).decode('utf-8')
        if not files:
            raise ValueError('empty source archive')
        return files


def go_profile(text, files):
    lines = text.splitlines()
    if not lines or lines[0] != 'mode: count':
        raise ValueError('expected count-mode Go profile')
    output = [lines[0]]
    for line in lines[1:]:
        match = re.fullmatch(
            r'github.com/k1LoW/mo/([A-Za-z0-9_./-]+\.go):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)',
            line,
        )
        if not match:
            raise ValueError('invalid Go profile row')
        path, *numbers = match.groups()
        start, column, end, end_column, statements, count = map(int, numbers)
        if (
            path not in files
            or not 0 < start <= end <= len(files[path].splitlines())
            or not 0 < column <= 1000000
            or not 0 < end_column <= 1000000
            or not 0 <= statements <= 1000000
            or not 0 <= count <= 2**53 - 1
        ):
            raise ValueError('Go profile points outside source or numeric bounds')
        output.append(line)
    if len(output) < 2:
        raise ValueError('empty Go profile')
    return '\n'.join(output) + '\n'


def lcov_profile(text, files):
    output, path, seen = [], None, set()
    for line in text.splitlines():
        if line.startswith('SF:'):
            path = line[3:]
            if 'internal/frontend/' + path not in files or path in seen:
                raise ValueError('LCOV points outside source or repeats a file')
            seen.add(path)
            output.append('SF:internal/frontend/' + path)
        elif line.startswith('DA:'):
            match = re.fullmatch(r'DA:(\d+),(\d+)(?:,[A-Fa-f0-9]+)?', line)
            if not match or path is None:
                raise ValueError('invalid LCOV line')
            number, count = map(int, match.groups())
            if (
                not 0 < number <= len(files['internal/frontend/' + path].splitlines())
                or count > 2**53 - 1
            ):
                raise ValueError('LCOV line outside source or numeric bounds')
            output.append(f'DA:{number},{count}')
        elif line == 'end_of_record':
            if path is None:
                raise ValueError('LCOV record without source')
            output.append(line)
            path = None
        elif not line.startswith(
            (
                'TN:',
                'FN:',
                'FNDA:',
                'FNF:',
                'FNH:',
                'LF:',
                'LH:',
                'BRDA:',
                'BRF:',
                'BRH:',
            )
        ):
            raise ValueError('unexpected LCOV field')
    if path is not None or not any(line.startswith('DA:') for line in output):
        raise ValueError('incomplete or empty LCOV')
    return '\n'.join(output) + '\n'


def prepare(source, reports, destination):
    files = source_files(source)
    with members(reports) as archive:
        go = go_profile(archive.read('coverage/go.out').decode('utf-8'), files)
        lcov = lcov_profile(archive.read('coverage/frontend/lcov.info').decode('utf-8'), files)
    destination.mkdir(mode=0o700)
    for relative, text in {**files, 'gate-go.out': go, 'gate-lcov.info': lcov}.items():
        path = destination / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        path.chmod(0o600)


if __name__ == '__main__':
    if sys.argv[1] == '--baseline':
        with members(Path(sys.argv[2])) as archive:
            sys.stdout.write(archive.read('baseline.json').decode('utf-8'))
    else:
        prepare(*(Path(argument) for argument in sys.argv[1:]))
