import * as path from 'path'
import exec from 'execa'
import * as fs from 'mz/fs'
import { AbortError } from './abort'
import {
    RepoSpec,
    CommitSpec,
    GitObjectID,
    FileSpec,
    RepoRootSpec,
    CodeSmell,
    File,
    Commit,
    CombinedFileDifference,
    ChangeKind,
} from './models'
import { UnknownRepositoryError, UnknownCommitError, UnknownRevisionError } from './errors'
import { take, filter } from 'ix/asynciterable/pipe/index'
import { sortBy } from 'lodash'
import { fromNodeStream } from 'ix'
import { AsyncIterableX } from 'ix/asynciterable'
import { keyBy } from './util'
import { IterableX } from 'ix/iterable'
import assert from 'assert'

export const resolveRepoDir = ({ repoRoot, repository }: RepoSpec & RepoRootSpec): string =>
    path.join(repoRoot, repository + '.git')

export async function filterValidCommits({
    repository,
    commitOids,
    repoRoot,
}: {
    repoRoot: string
    repository: string
    commitOids: Iterable<GitObjectID>
}): Promise<GitObjectID[]> {
    repository = validateRepositoryName({ repository })
    try {
        const { stdout } = await exec('git', ['rev-list', '--ignore-missing', '--no-walk', '--stdin', '--'], {
            cwd: resolveRepoDir({ repoRoot, repository }),
            input: IterableX.from(commitOids)
                .filter(c => /[a-f0-9]{40}/.test(c))
                .map(commitOid => commitOid + '\n')
                .toNodeStream(),
        })
        return stdout.split('\n').filter(Boolean)
    } catch (err) {
        if (err.killed) {
            throw new AbortError()
        }
        if (err.code === 'ENOENT') {
            throw new UnknownRepositoryError({ repository })
        }
        throw err
    }
}

export function validateObjectID(value: unknown): GitObjectID {
    if (typeof value !== 'string' || !/[a-z0-9]{40}/.test(value)) {
        throw new Error('Not a valid Git object ID: ' + value)
    }
    return value
}

export function validateRelativeRepoPath(value: string): string {
    value = path.posix.normalize(value)
    if (path.posix.isAbsolute(value)) {
        throw new Error('Path is absolute')
    }
    if (/(^|\/)\.\.(\/|$)/.test(value)) {
        throw new Error('Path contains relative references')
    }
    return value
}

export async function checkCommitExists({
    repository,
    commit,
    repoRoot,
}: {
    repoRoot: string
    repository: string
    commit: GitObjectID
}): Promise<void> {
    validateObjectID(commit)
    const filtered = await filterValidCommits({ repository, commitOids: [commit], repoRoot })
    if (filtered.length === 0) {
        throw new UnknownCommitError({ repository, commit })
    }
}

export async function getFileContent({
    repoRoot,
    repository,
    commit,
    file,
}: RepoRootSpec & RepoSpec & FileSpec & CommitSpec): Promise<Buffer> {
    repository = validateRepositoryName({ repository })
    commit = validateObjectID(commit)
    const { stdout } = await exec('git', ['show', `${commit}:${file}`], {
        encoding: null,
        cwd: resolveRepoDir({ repoRoot, repository }),
    })
    return stdout
}

enum FormatTokens {
    commitOid = '%H',
    newLine = '%n',
    authorName = '%aN',
    authorEmail = '%aE',
    authorIsoDateStrict = '%aI',
    committerName = '%cN',
    committerEmail = '%cE',
    committerIsoDateStrict = '%cI',
    parentHashes = '%P',
    bodyRaw = '%B',
}
const commitFormat: string = [
    FormatTokens.commitOid,
    FormatTokens.parentHashes,
    FormatTokens.authorName,
    FormatTokens.authorEmail,
    FormatTokens.authorIsoDateStrict,
    FormatTokens.committerName,
    FormatTokens.committerEmail,
    FormatTokens.committerIsoDateStrict,
    FormatTokens.bodyRaw,
].join(FormatTokens.newLine)

/**
 * Parse a git output chunk formatted according to `commitFormat`.
 */
const parseCommit = (chunk: string): Commit => {
    const [
        oid,
        parentHashes,
        authorName,
        authorEmail,
        authorDate,
        committerName,
        committerEmail,
        committerDate,
        ...messageLines
    ] = chunk.split('\n')
    return {
        oid,
        parents: parentHashes === '' ? [] : parentHashes.split(' '),
        author: {
            name: authorName,
            email: authorEmail,
            date: authorDate,
        },
        committer: {
            name: committerName,
            email: committerEmail,
            date: committerDate,
        },
        message: messageLines.join('\n'),
    }
}

export async function getCommits({
    repoRoot,
    repository,
    commitOids,
}: {
    repoRoot: string
    repository: string
    commitOids: Iterable<GitObjectID>
}): Promise<ReadonlyMap<GitObjectID, Commit>> {
    repository = validateRepositoryName({ repository })
    // Bulk-validate the commits first, because git show fails hard on bad revisions
    const filteredCommitOids = await filterValidCommits({ repoRoot, repository, commitOids })
    try {
        const { stdout } = await exec(
            'git',
            [
                'show',
                '--no-decorate',
                '--no-patch',
                '--no-color',
                '-z', // seperate commits with NULL bytes
                `--format=${commitFormat}`,
                ...filteredCommitOids,
                '--',
            ],
            { cwd: resolveRepoDir({ repoRoot, repository }) }
        )
        const commits = IterableX.from(stdout.split('\0'))
            .filter(chunk => chunk !== '')
            .map(parseCommit)
        const commitsByOid = keyBy(commits, c => c.oid)
        return commitsByOid
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new UnknownRepositoryError({ repository })
        }
        throw err
    }
}

const commitChangesFormat = ['%x00', FormatTokens.commitOid].join('')
export async function getCombinedCommitDifference({
    repoRoot,
    repository,
    commitOids,
}: {
    repoRoot: string
    repository: string
    commitOids: IterableX<GitObjectID>
}): Promise<ReadonlyMap<GitObjectID, CombinedFileDifference[]>> {
    // Bulk-validate the commits first, because git show fails hard on bad revisions
    const filteredCommitOids = await filterValidCommits({ repoRoot, repository, commitOids })
    try {
        const { stdout } = await exec(
            'git',
            [
                'show',
                '--no-decorate',
                '--no-color',
                '--name-status',
                '--find-renames',
                '--find-copies',
                '--cc',
                '--combined-all-paths', // List the file path from each parent
                `--format=${commitChangesFormat}`,
                ...filteredCommitOids,
                '--',
            ],
            { cwd: resolveRepoDir({ repoRoot, repository }) }
        )
        const map = new Map<GitObjectID, CombinedFileDifference[]>()
        const commitsWithChanges = IterableX.from(stdout.split('\0'))
            .filter(line => line !== '')
            .map(commitChunk => {
                const [oid, ...fileLines] = commitChunk.split('\n')
                const changes = fileLines
                    .filter(fileLine => fileLine !== '')
                    .map(fileLine => {
                        const [gitChangeKinds, gitHeadPath, ...gitBasePaths] = fileLine.split('\t')
                        const changeKinds = gitChangeKinds
                            // Filter out rename, copy, modified similarity scores
                            .replace(/\d/g, '')
                            .split('') as ChangeKind[]
                        let headPath: string | null = gitHeadPath
                        // Git only returns base paths for merge commits, renames and copies
                        // If none is given, its the same as the head paths
                        const basePaths: (string | null)[] =
                            gitBasePaths.length > 0 ? gitBasePaths : [headPath]
                        for (const [baseIndex, changeKind] of changeKinds.entries()) {
                            switch (changeKind) {
                                case ChangeKind.Added:
                                    // If the file was added compared to this base,
                                    // it didn't exist in the base and the path should be null
                                    basePaths[baseIndex] = null
                                    break
                                case ChangeKind.Deleted:
                                    // If the file was deleted compared to any of the bases,
                                    // it doesn't exist in the head and the path should be null
                                    headPath = null
                                    break
                            }
                        }
                        return { changeKinds, headPath, basePaths }
                    })
                return { oid, changes }
            })
        for (const { oid, changes } of commitsWithChanges) {
            map.set(oid, changes)
        }
        return map
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new UnknownRepositoryError({ repository })
        }
        throw err
    }
}

export async function getFileContents({
    repoRoot,
    repository,
    files,
}: {
    repoRoot: string
    repository: string
    files: (CommitSpec & FileSpec)[]
}): Promise<(string | null)[]> {
    const fileStrings = files.map(f => `${f.commit}:${f.file}`)
    try {
        const { stdout } = await exec('git', ['cat-file', '--batch', '--format=>>>%(rest)'], {
            cwd: resolveRepoDir({ repoRoot, repository }),
            input: fileStrings.map(f => `${f} ${f}`).join('\n'),
        })
        const lines = stdout.split('\n')
        let fileStringIndex = 0
        let start = 0
        const contents: (string | null)[] = []
        for (const [lineNo, line] of lines.entries()) {
            if (line === '>>>' + fileStrings[fileStringIndex]) {
                const end = lineNo - 1
                contents.push(lines.slice(start, end).join('\n'))
                start = lineNo + 1
                fileStringIndex++
            } else if (line === '>>>' + fileStrings[fileStringIndex] + ' missing') {
                contents.push(null)
                fileStringIndex++
                start = lineNo + 1
            }
        }
        return contents
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new UnknownRepositoryError({ repository })
        }
        throw err
    }
}

export async function listFiles({
    repository,
    commit,
    repoRoot,
    directory,
}: {
    repository: string
    commit: GitObjectID
    repoRoot: string
    directory?: string | null
}): Promise<File[]> {
    commit = validateObjectID(commit)
    repository = validateRepositoryName({ repository })
    try {
        if (directory) {
            directory = validateRelativeRepoPath(directory)
        }
        const { stdout } = await exec(
            'git',
            ['ls-tree', '-r', '--name-only', '--full-name', commit, ...(directory ? [directory] : [])],
            { cwd: resolveRepoDir({ repoRoot, repository }) }
        )
        return stdout.split('\n').map(path => ({ path }))
    } catch (err) {
        if (err.killed) {
            throw new AbortError()
        }
        if (err.exitCode === 128 && err.stderr?.includes('fatal: not a tree object')) {
            throw new UnknownCommitError({ repository, commit })
        }
        throw err
    }
}

export function validateRepositoryName({ repository }: RepoSpec): string {
    if (!/^[\w-_.]+$/.test(repository)) {
        throw Object.assign(new Error('Invalid repository name'), { status: 400 })
    }
    if (repository.endsWith('.git')) {
        throw Object.assign(new Error('Repository names cannot end with .git'), { status: 400 })
    }
    return repository
}

export async function checkRepositoryExists({
    repository,
    repoRoot,
}: {
    repository: string
    repoRoot: string
}) {
    repository = validateRepositoryName({ repository })
    try {
        await fs.stat(resolveRepoDir({ repoRoot, repository }))
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new UnknownRepositoryError({ repository })
        }
        throw err
    }
}

export async function listRepositories({ repoRoot }: RepoRootSpec): Promise<string[]> {
    const directories = await fs.readdir(repoRoot)
    return directories.map(dir => dir.replace(/\.git$/, ''))
}

export interface GitLogFilters {
    /** The revision to start walking the history at. */
    startRevision?: string

    /** Limit the commits output to ones with log message that matches the specified pattern (regular expression). */
    messagePattern?: string

    /** Return commits more recent than a specific date. */
    since?: string

    /** Return commits older than a specific date. */
    until?: string

    /** Return only the history of the given directory or file. */
    path?: string
}

export interface GitLogPagination {
    skip?: number
    maxCount?: number
}

export const log = ({
    repoRoot,
    repository,
    startRevision = 'HEAD',
    path,
    messagePattern,
    since,
    until,
    skip,
    maxCount,
}: RepoRootSpec & RepoSpec & GitLogFilters & GitLogPagination): AsyncIterableX<Commit> => {
    if (startRevision.includes('..')) {
        throw new Error(`Start revision cannot be a revision range: ${startRevision}`)
    }
    repository = validateRepositoryName({ repository })
    const cwd = resolveRepoDir({ repoRoot, repository })
    const gitProcess = exec(
        'git',
        [
            'log',
            '-z',
            `--format=${commitFormat}`,
            ...(messagePattern
                ? [`--grep=${messagePattern}`, '--extended-regexp', '--regexp-ignore-case']
                : []),
            ...(since ? [`--since=${since}`] : []),
            ...(until ? [`--until=${until}`] : []),
            ...(skip ? [`--skip=${skip}`] : []),
            ...(maxCount ? [`--max-count=${maxCount}`] : []),
            startRevision,
            '--',
            ...(path ? [path] : []),
        ],
        { cwd }
    )
    return AsyncIterableX.from(gitProcess.stdout!)
        .catchWith<Buffer>(err => {
            if (err.killed) {
                throw new AbortError()
            }
            if (err.code === 'ENOENT') {
                throw new UnknownRepositoryError({ repository })
            }
            if (err.exitCode === 128 && err.stderr?.startsWith('fatal: bad object')) {
                throw new UnknownCommitError({ repository, commit: startRevision })
            }
            if (err.exitCode === 128 && err.stderr?.startsWith('fatal: bad revision')) {
                throw new UnknownRevisionError({ repository, revision: startRevision })
            }
            throw err
        })
        .pipe(split('\0'))
        .map(parseCommit)
        .finally(() => gitProcess.kill())
}

export async function init({
    repoRoot,
    repository,
}: {
    repoRoot: string
    repository: string
}): Promise<void> {
    repository = validateRepositoryName({ repository })
    const repo = resolveRepoDir({ repoRoot, repository })
    await fs.mkdir(repo)
    await exec('git', ['init', '--bare'], { cwd: repo })
    // Allow git push
    await exec('git', ['config', '--bool', 'http.receivepack', 'true'], { cwd: repo })
}

export function unbundle({
    repoRoot,
    repository,
    bundlePath,
}: {
    repoRoot: string
    repository: string
    bundlePath: string
}): exec.ExecaChildProcess {
    repository = validateRepositoryName({ repository })
    const cwd = resolveRepoDir({ repoRoot, repository })
    // Fetch all branches and tags from the bundle
    // No "+", must be a fast forward
    return exec('git', ['fetch', '--tags', bundlePath, 'refs/heads/*:refs/heads/*'], { cwd })
}

/**
 * Turns a sequence of text chunks into a sequence of lines (where lines are separated by newlines).
 */
const split = (seperator: string) =>
    async function*(chunks: AsyncIterable<string | Buffer>): AsyncIterable<string> {
        let previous = ''
        for await (const chunk of chunks) {
            previous += chunk.toString()
            let eolIndex: number
            while ((eolIndex = previous.indexOf(seperator)) >= 0) {
                yield previous.slice(0, eolIndex)
                previous = previous.slice(eolIndex + 1)
            }
        }
        if (previous.length > 0) {
            yield previous
        }
    }
