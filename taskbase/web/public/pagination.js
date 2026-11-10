export function pagination({ page, pages, total, onPage }) {
  const root = document.createElement('div');
  root.className = 'queue-pagination';
  const button = (label, disabled, target) => {
    const node = document.createElement('button');
    node.type = 'button'; node.className = 'btn btn-sm'; node.disabled = disabled;
    node.textContent = label;
    node.addEventListener('click', () => { void onPage(target); });
    return node;
  };
  const label = document.createElement('span');
  label.className = 'hint'; label.textContent = `第 ${page} / ${pages} 页 · 共 ${total} 项`;
  root.append(button('上一页', page <= 1, page - 1), label, button('下一页', page >= pages, page + 1));
  return root;
}

export function cursorPagination(cursors, nextCursor, onPage) {
  const root = pagination({ page: cursors.length, pages: cursors.length + (nextCursor ? 1 : 0),
    total: '—', onPage: (page) => {
      if (page < cursors.length) cursors.pop();
      else cursors.push(nextCursor);
      return onPage();
    },
  });
  root.querySelector('span').textContent = `第 ${cursors.length} 页`;
  return root;
}
