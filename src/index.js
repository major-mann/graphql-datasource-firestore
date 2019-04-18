module.exports = createGraphqlFirebaseSource;

const LIMIT = 200;

const createGraphqlDatasource = require('@major-mann/graphql-datasource-base');
const Firestore = require('@google-cloud/firestore');

const { FieldPath } = Firestore;

// Note: these are mainly here for testing with npm link
createGraphqlFirebaseSource.graphql = createGraphqlDatasource.graphql;
createGraphqlFirebaseSource.Firestore = Firestore;

async function createGraphqlFirebaseSource({ firestore, definitions, graphqlOptions, rootTypes, idFieldSelector }) {
    const collections = {};
    const source = await createGraphqlDatasource({
        rootTypes,
        definitions,
        graphqlOptions,
        idFieldSelector,
        data: loadCollection
    });
    return source;

    async function loadCollection({ id: idField, name, type, definition }) {
        if (collections[name]) {
            return collections[name];
        }

        const collection = firestore.collection(name);
        collections[name] = {
            find,
            list,
            create,
            upsert,
            update,
            delete: remove
        };
        return collections[name];

        async function create(id, data) {
            if (id) {
                await collection.doc(id).create(data);
                return id;
            } else {
                const doc = await collection.add(data);
                return doc.id;
            }
        }

        async function upsert(id, data) {
            await collection.doc(id).set(data);
        }

        async function update(id, data) {
            await collection.doc(id).update(data);
        }

        async function remove(id) {
            await collection.doc(id).delete();
        }

        async function find(id) {
            const record = await collection
                .doc(id)
                .get();
            if (record.exists) {
                return {
                    [idField]: record.id,
                    ...record.data()
                };
            } else {
                return undefined;
            }
        }

        async function list({ filter, order, before, after, first, last }) {
            // https://facebook.github.io/relay/graphql/connections.htm
            let query = collection;
            if (first < 0) {
                throw new Error('When supplied, first MUST be greater than or equal to 0');
            }
            if (last < 0) {
                throw new Error('When supplied, last MUST be greater than or equal to 0');
            }
            if (first === 0 || last === 0) {
                return empty();
            }
            if (first > 0 && last > 0 && first > last) {
                // This just simplifies the conditions later
                last = undefined;
            }

            const limit = calculateLimit();
            if (limit > LIMIT) {
                throw new Error('The maximum number of records that can be requested (using first and last) ' +
                    `is ${LIMIT}. Received ${limit} (first: ${first}. last: ${last})`);
            }

            if (filter) {
                filter.forEach(processFilter);
            }
            const tailQuery = !before &&
                (
                    first > 0 === false && last > 0 ||
                    last > first
                );
            order = orderInstructions(order, tailQuery);
            order.forEach(ord => query = query.orderBy(...ord));

            if (after) {
                hasPreviousPage = true;
                after = deserializeCursor(after);
                query = query.startAfter(...after);
            }
            if (before) {
                hasNextPage = true;
                before = deserializeCursor(before);
                query = query.endBefore(...before);
            }
            query = query.limit(limit + 1);

            const results = await exec();

            // We had to play with the ordering (in order instructions) to get the tail
            if (tailQuery) {
                results.reverse();
            }

            // TODO: Would like to analyze this and make it more efficient / cleaner
            if (after) {
                hasPreviousPage = true;
                if (before && matches(results[results.length - 1], order, before)) {
                    hasNextPage = true;
                    trimStart(results, limit); // TODO: Is this needed?
                } else if (first > 0 && last > first) {
                    hasNextPage = results.length > limit;
                    trimStart(results, first);
                } else if (first > 0) {
                    hasNextPage = results.length > limit;
                    trimEnd(results, limit);
                } else { // last > 0
                    hasNextPage = false;
                    trimStart(results, limit);
                }
            } else if (before) { // && !after
                hasNextPage = true;
                if (first > 0 && last > first) {
                    hasPreviousPage = true;
                    trimStart(results, first);
                } else if (first > 0) {
                    hasPreviousPage = results.length > limit;
                    trimEnd(results, limit);
                } else { // last > 0
                    hasPreviousPage = results.length > limit;
                    trimStart(results, limit);
                }
            } else { // !before && !after
                if (first > 0 && last > first) {
                    hasPreviousPage = true;
                    hasNextPage = results.length > limit;
                    trimStart(results, first);
                } else if (first > 0) {
                    hasPreviousPage = false;
                    hasNextPage = results.length > limit;
                    trimEnd(results, limit);
                } else { // last > 0
                    hasNextPage = false;
                    hasPreviousPage = results.length > limit;
                    trimStart(results, limit);
                }
            }

            return {
                edges: results.map(processRecord),
                pageInfo: {
                    hasNextPage: hasNextPage,
                    hasPreviousPage: hasPreviousPage
                }
            };

            function trimStart(arr, length) {
                if (length < arr.length) {
                    arr.splice(0, arr.length - length);
                }
            }

            function trimEnd(arr, length) {
                if (length < arr.length) {
                    arr.splice(length);
                }
            }

            function matches(record, order, cursor) {
                return order.every((instruction, index) => record[instruction[0]] === cursor[index]);
            }

            function processRecord(record) {
                const cursorValue = order.map(instruction => fieldValue(instruction[0]));
                return {
                    // TODO: Need the fields passed in to this function....
                    // TODO: Avoid supplying cursor if not requested
                    //      info.fieldNodes[].selectionSet.selections[].name.value
                    cursor: serializeCursor(cursorValue),
                    node: record
                };

                function fieldValue(field) {
                    if (field === FieldPath.documentId()) {
                        return record[idField];
                    } else {
                        return record[field];
                    }
                }
            }

            async function exec() {
                const snapshot = await query.get();
                const records = [];
                snapshot.forEach(record => records.push({
                    [idField]: record.id,
                    ...record.data()
                }));
                return records;
            }

            function empty() {
                return {
                    edges: [],
                    pageInfo: {
                        hasPreviousPage: false,
                        hasNextPage: false
                    }
                }
            }

            function calculateLimit() {
                if (first >=0 && last >= 0) {
                    return Math.max(first, last);
                } else if (first >= 0) {
                    return first;
                } else if (last >= 0) {
                    return last;
                } else {
                    return LIMIT;
                }
            }

            function orderInstructions(supplied, isTailQuery) {
                supplied = supplied || [];
                const instructions = [];
                if (supplied.length === 0) {
                    if (isTailQuery) {
                        instructions.push(createInstruction(FieldPath.documentId(), true));
                    } else if (before || after) { // Add a default order so we can call pagination methods
                        instructions.push(createInstruction(FieldPath.documentId()));
                    }
                } else {
                    if (isTailQuery) {
                        supplied = supplied.map(item => ({ field: item.field, desc: !item.desc }));
                    }
                    instructions.push(...supplied.map(item => createInstruction(item.field, item.desc)));
                }
                return instructions;

                function createInstruction(field, desc) {
                    if (desc) {
                        return [field, 'desc'];
                    } else {
                        return [field];
                    }
                }
            }

            function processFilter(filter) {
                query = query.where(filter.field, operator(filter.op), filter.value);
            }

            function serializeCursor(cursor) {
                const jsonSource = JSON.stringify(cursor);
                return Buffer.from(jsonSource, 'utf8').toString('base64');
            }

            function deserializeCursor(base64Source) {
                const jsonSource = Buffer.from(base64Source, 'base64')
                    .toString('utf8');
                const parsed = JSON.parse(jsonSource);
                if (Array.isArray(parsed)) {
                    return parsed;
                } else {
                    return [parsed];
                }
            }
        }
    }

    function operator(op) {
        switch (op) {
            case 'LT':
                return '<';
            case 'LTE':
                return '<=';
            case 'EQ':
                return '==';
            case 'GTE':
                return '>=';
            case 'GT':
                return '>';
            case 'CONTAINS':
                return 'CONTAINS'
            default:
                throw new Error(`Unsupported operation "${op}"`);
        }
    }

}
